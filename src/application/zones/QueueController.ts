import type { ComponentLogger } from '@/shared/logging/logger';
import type { ContentFolderItem } from '@/ports/ContentTypes';
import type { ContentPort } from '@/ports/ContentPort';
import type { NotifierPort } from '@/ports/NotifierPort';
import { decodeAudiopath, detectServiceFromAudiopath } from '@/domain/loxone/audiopath';
import {
  createQueueItem,
  mapFolderItemsToQueue,
  normalizeSpotifyAudiopath,
  parseSpotifyUser,
} from '@/application/zones/helpers/queueHelpers';
import { clamp, fallbackTitle, sanitizeTitle } from '@/application/zones/helpers/stateHelpers';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import type { QueueAuthority, QueueItem, ZoneContext } from '@/application/zones/internal/zoneTypes';
import { ZoneRepository } from '@/application/zones/ZoneRepository';

type QueueControllerDeps = {
  log: ComponentLogger;
  contentPort: ContentPort;
  applyPatch: (zoneId: number, patch: Partial<LoxoneZoneState>, force?: boolean) => void;
  isRadioAudiopath: (audiopath: string | undefined, audiotype?: number | null) => boolean;
  isSpotifyAudiopath: (audiopath: string | null | undefined) => boolean;
  isMusicAssistantAudiopath: (audiopath: string | null | undefined) => boolean;
  isAppleMusicAudiopath: (audiopath: string | null | undefined) => boolean;
  isDeezerAudiopath: (audiopath: string | null | undefined) => boolean;
  isTidalAudiopath: (audiopath: string | null | undefined) => boolean;
  resolveBridgeProvider: (rawAudiopath: string | undefined | null) => string | null;
  getMusicAssistantUserId: () => string;
  getStateAudiotype: (ctx: ZoneContext, item?: QueueItem | null) => number | null;
  getStateFileType: () => number;
  resolveSourceName: (
    audiotype: number | null | undefined,
    ctx: ZoneContext,
    current?: QueueItem | null,
  ) => string | undefined;
  notifier: NotifierPort;
};

export class QueueController {
  private readonly log: ComponentLogger;
  private readonly contentPort: ContentPort;

  constructor(
    private readonly zoneRepo: ZoneRepository,
    private readonly deps: QueueControllerDeps,
  ) {
    this.log = deps.log;
    this.contentPort = deps.contentPort;
  }

  public getQueue(zoneId: number, start: number, limit: number) {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return {
        id: zoneId,
        items: [],
        shuffle: false,
        start: 0,
        totalitems: 0,
        authority: 'local' as QueueAuthority,
      };
    }

    if (this.deps.isRadioAudiopath(ctx.state.audiopath, ctx.state.audiotype)) {
      return {
        id: zoneId,
        items: [],
        shuffle: ctx.queue.shuffle,
        start: 0,
        totalitems: 0,
        authority: ctx.queue.authority,
      };
    }

    if (ctx.queue.shuffle && !ctx.metadata.queueShuffled) {
      this.reorderQueue(ctx, 'shuffle', { keepCurrent: true, shuffleUpcoming: true });
    }

    const slice = ctx.queue.items.slice(start, start + limit).map((item) => {
      const { originalIndex: _originalIndex, ...rest } = item;
      return {
        ...rest,
        // Loxone kan geen spotify@username prefixes aan; strip alleen voor output.
        audiopath: sanitizeAudiopathForOutput(item.audiopath),
        // Mask station for local/library items so they don't show as radio entries.
        station: (item.audiopath ?? '').startsWith('library:') ? '' : item.station ?? '',
      };
    });
    this.log.debug('getQueue', {
      zoneId,
      start,
      limit,
      total: ctx.queue.items.length,
      returned: slice.length,
    });
    return {
      id: zoneId,
      items: slice,
      shuffle: ctx.queue.shuffle,
      start,
      totalitems: ctx.queue.items.length,
      authority: ctx.queue.authority,
    };
  }

  public isLocalQueueAuthority(authority: QueueAuthority | undefined | null): boolean {
    return !authority || authority === 'local';
  }

  public seekInQueue(zoneId: number, target: string): boolean {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return false;
    }
    return this.seekExistingQueueInternal(ctx, target);
  }

  public setShuffle(zoneId: number, enabled: boolean): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    const wasEnabled = ctx.queue.shuffle;
    ctx.queue.shuffle = enabled;
    this.deps.applyPatch(zoneId, { plshuffle: enabled ? 1 : 0 });
    if (enabled === wasEnabled) {
      if (enabled && !ctx.metadata.queueShuffled) {
        this.reorderQueue(ctx, 'shuffle', { keepCurrent: true, shuffleUpcoming: true });
      } else if (!enabled && ctx.metadata.queueShuffled) {
        this.reorderQueue(ctx, 'unshuffle', { keepCurrent: true, shuffleUpcoming: true });
      }
      return;
    }
    this.reorderQueue(ctx, enabled ? 'shuffle' : 'unshuffle', {
      keepCurrent: true,
      shuffleUpcoming: true,
    });
  }

  public setPendingShuffle(zoneId: number, enabled: boolean): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    ctx.metadata.pendingShuffle = enabled;
  }

  public setRepeatMode(zoneId: number, mode: 'off' | 'one' | 'all'): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    const repeat = mode === 'one' ? 3 : mode === 'all' ? 1 : 0;
    ctx.queue.repeat = repeat;
    this.deps.applyPatch(zoneId, { plrepeat: repeat });
  }

  public updateQueueFromOutput(zoneId: number, items: QueueItem[], currentIndex: number): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx || !Array.isArray(items)) {
      return;
    }
    if (ctx.alert) {
      return;
    }
    if (items.length === 0) {
      // Ignore empty snapshots from outputs so we don't wipe the local queue on transient polls.
      return;
    }
    let applyItems = items;
    let applyIndex = currentIndex;
    const existingItems = ctx.queue.items ?? [];

    // If the output only returns the current item, merge it into the existing queue
    // instead of wiping the full queue that the user built.
    if (items.length === 1 && existingItems.length > 1) {
      const targetIndex = Math.max(
        0,
        Math.min(
          typeof currentIndex === 'number' ? currentIndex : ctx.queueController.currentIndex(),
          existingItems.length - 1,
        ),
      );
      applyItems = existingItems.map((existing, idx) =>
        idx === targetIndex ? { ...existing, ...items[0], qindex: idx } : { ...existing, qindex: idx },
      );
      applyIndex = targetIndex;
      this.log.debug('queue update merged single output item into existing queue', {
        zoneId,
        targetIndex,
        existing: existingItems.length,
      });
    }

    // Skip queue update if nothing changed (same items and index).
    const buildSignature = (list: QueueItem[]): string =>
      `${list.length}:${list
        .map((item) => normalizeSpotifyAudiopath(item.audiopath ?? '') || '')
        .join('|')}`;
    const newSignature = buildSignature(applyItems);
    const prevSignature = ctx.metadata.lastQueueSignature as string | undefined;
    const prevIndex = ctx.queueController.currentIndex();
    const targetIndex =
      typeof applyIndex === 'number' && applyItems.length
        ? Math.max(0, Math.min(applyIndex, applyItems.length - 1))
        : prevIndex;
    const signatureUnchanged = newSignature === prevSignature && targetIndex === prevIndex;

    const current = signatureUnchanged
      ? ctx.queueController.current()
      : ctx.queueController.updateFromOutput(applyItems, targetIndex);
    if (!current) {
      return;
    }
    const authority = this.resolveQueueAuthorityFromItems(applyItems);
    if (authority) {
      ctx.queue.authority = authority;
    }
    if (!signatureUnchanged) {
      ctx.metadata.lastQueueSignature = newSignature;
      ctx.metadata.lastQueueIndex = ctx.queueController.currentIndex();
      this.log.debug('queue updated from output', {
        zoneId: ctx.id,
        items: items.length,
        currentIndex: ctx.queueController.currentIndex(),
        authority: ctx.queue.authority,
      });
    }
    const duration =
      typeof current.duration === 'number' && current.duration > 0
        ? current.duration
        : typeof ctx.state.duration === 'number'
          ? ctx.state.duration
          : 0;
    const fallback = fallbackTitle(ctx.state.title, ctx.name);
    const nextTitle = sanitizeTitle(current.title, fallback);
    const useTitle =
      nextTitle !== (ctx.state.title ?? '') || (current.title && !nextTitle.startsWith(ctx.name));
    const stateAudiotype = this.deps.getStateAudiotype(ctx, current);
    const displayAudiotype = stateAudiotype ?? current.audiotype;
    const sourceName = this.deps.resolveSourceName(displayAudiotype, ctx, current);
    this.deps.applyPatch(zoneId, {
      ...(useTitle ? { title: nextTitle } : {}),
      artist: current.artist,
      album: current.album,
      coverurl: current.coverurl,
      audiopath: current.audiopath,
      station: current.station,
      qindex: ctx.queueController.currentIndex(),
      qid: current.unique_id,
      type: this.deps.getStateFileType(),
      ...(displayAudiotype != null ? { audiotype: displayAudiotype } : {}),
      duration: duration > 0 ? duration : undefined,
      queueAuthority: ctx.queue.authority,
      ...(sourceName ? { sourceName } : {}),
    });
    if (duration <= 0) {
      void this.resolveTrackDuration(current.audiopath).then((dur) => {
        if (dur > 0) {
          this.deps.applyPatch(zoneId, { duration: dur });
        }
      });
    }
    if (!this.deps.isRadioAudiopath(current.audiopath, current.audiotype)) {
      this.deps.notifier.notifyQueueUpdated(zoneId, ctx.queue.items.length);
    }
  }

  public async buildQueueForUri(
    uri: string,
    zoneName: string,
    station?: string,
    rawAudiopath?: string,
    options?: { maxItems?: number },
  ): Promise<QueueItem[]> {
    const stripRoutingSuffixLocal = (value: string): string =>
      value
        .replace(/\/parentid\/.*$/i, '')
        .replace(/\/parentpath\/.*$/i, '')
        .replace(/\/noshuffle.*$/i, '')
        .replace(/\/\?q&ZW5mb3JjZVVzZXI9dHJ1ZQ.*$/i, '')
        .replace(/\/\?q&[A-Za-z0-9+/=]+$/i, '')
        .replace(/\/+$/, '');
    const rawPath = rawAudiopath ?? uri;
    const rawLower = (rawPath || '').toLowerCase();
    const bridgeProvider = this.deps.resolveBridgeProvider(rawPath);
    const forceSpotify = rawLower.startsWith('spotify@') && !bridgeProvider;
    const rawClean = stripRoutingSuffixLocal(rawPath);
    const decoded = forceSpotify ? rawClean : decodeAudiopath(uri);
    if (!decoded) {
      return [];
    }
    const maxItems = typeof options?.maxItems === 'number' && options.maxItems > 0 ? options.maxItems : undefined;
    const pickSourcePath = (): string => {
      if (station && station.trim()) {
        return station.trim();
      }
      const candidate = (decoded || rawAudiopath || uri || '').trim();
      if (candidate.includes(':')) {
        return candidate;
      }
      if (rawClean && rawClean.includes(':')) {
        return rawClean;
      }
      return candidate;
    };
    const isMusicAssistant = bridgeProvider === 'musicassistant' || (!forceSpotify && this.deps.isMusicAssistantAudiopath(rawPath));
    const service =
      bridgeProvider ||
      (forceSpotify
        ? 'spotify'
        : isMusicAssistant
          ? 'musicassistant'
          : detectServiceFromAudiopath(rawPath));
    const isAppleMusic = !forceSpotify && (service === 'applemusic' || /applemusic/i.test(rawPath));
    const isDeezer = !forceSpotify && (service === 'deezer' || /deezer/i.test(rawPath));
    const isTidal = !forceSpotify && (service === 'tidal' || /tidal/i.test(rawPath));
    const defaultSpotifyUserId = this.contentPort.getDefaultSpotifyAccountId();

    // Local library content
    if (!forceSpotify && (decoded.startsWith('library:') || decoded.startsWith('library-'))) {
      const folder = await this.contentPort.getMediaFolder(decoded, 0, 500);
      if (folder?.items?.length) {
        // local library items are not radio; do not propagate station
        const trimmed = maxItems ? folder.items.slice(0, maxItems) : folder.items;
        return mapFolderItemsToQueue(trimmed, zoneName, 0, 'nouser', '', defaultSpotifyUserId);
      }
      const meta = await this.contentPort.resolveMetadata(decoded);
      if (meta) {
        return [createQueueItem(uri, zoneName, meta, 0, defaultSpotifyUserId)];
      }
      return [];
    }

    // Music Assistant bridge content
    if (!forceSpotify && (isMusicAssistant || service === 'musicassistant' || /musicassistant/i.test(rawPath))) {
      const user = this.deps.getMusicAssistantUserId();
      const sourcePath = pickSourcePath();
      const folderId = sourcePath
        .replace(/^spotify@[^:]+:/i, '')
        .replace(/^musicassistant@[^:]+:/i, '')
        .replace(/^spotify:/i, '')
        .replace(/^musicassistant:/i, '');
      if (folderId.toLowerCase().startsWith('track:')) {
        const trackId = folderId.split(':').pop() ?? '';
        const track = await this.contentPort.getServiceTrack('musicassistant', user, trackId);
        if (track) {
          return mapFolderItemsToQueue([track], zoneName, 5, user, undefined, defaultSpotifyUserId);
        }
      }
      const allItems: ContentFolderItem[] = [];
      const pageSize = 50;
      let offset = 0;
      let total = Number.MAX_SAFE_INTEGER;
      while (offset < total) {
        const folder = await this.contentPort.getServiceFolder('musicassistant', user, folderId, offset, pageSize);
        const items = folder?.items ?? [];
        if (items.length === 0) {
          break;
        }
        allItems.push(...items);
        total = Number.isFinite(folder?.totalitems) ? (folder as any).totalitems : Number.MAX_SAFE_INTEGER;
        offset += items.length;
        if (items.length < pageSize) {
          break;
        }
        if (maxItems && allItems.length >= maxItems) {
          break;
        }
        if (allItems.length >= 1000) {
          break;
        }
      }
      if (allItems.length) {
        const trimmed = maxItems ? allItems.slice(0, maxItems) : allItems;
        return mapFolderItemsToQueue(trimmed, zoneName, 5, user, station ?? rawClean, defaultSpotifyUserId);
      }
    }

    // Apple Music bridge content
    if (!forceSpotify && (isAppleMusic || service === 'applemusic' || /applemusic/i.test(rawPath))) {
      const providerId = rawClean.split(':')[0] || 'applemusic';
      const user = providerId.split('@')[1] ?? 'applemusic';
      const sourcePath = pickSourcePath();
      const folderId = sourcePath
        .replace(/^spotify@[^:]+:/i, '')
        .replace(/^applemusic@[^:]+:/i, '')
        .replace(/^spotify:/i, '')
        .replace(/^applemusic:/i, '');
      if (/^(library-)?track:/i.test(folderId)) {
        const trackId = folderId.split(':').slice(1).join(':');
        const track = await this.contentPort.getServiceTrack(
          providerId,
          user,
          `${folderId.split(':')[0]}:${trackId}`,
        );
        if (track) {
          return mapFolderItemsToQueue([track], zoneName, 5, user, undefined, defaultSpotifyUserId);
        }
        this.log.debug('apple music queue track lookup failed', {
          providerId,
          folderId,
          trackId,
        });
      }
      const allItems: ContentFolderItem[] = [];
      const pageSize = 50;
      let offset = 0;
      let total = Number.MAX_SAFE_INTEGER;
      while (offset < total) {
        const folder = await this.contentPort.getServiceFolder(providerId, user, folderId, offset, pageSize);
        const items = folder?.items ?? [];
        if (items.length === 0) {
          break;
        }
        allItems.push(...items);
        total = Number.isFinite(folder?.totalitems) ? (folder as any).totalitems : Number.MAX_SAFE_INTEGER;
        offset += items.length;
        if (items.length < pageSize) {
          break;
        }
        if (maxItems && allItems.length >= maxItems) {
          break;
        }
        if (allItems.length >= 1000) {
          break;
        }
      }
      if (allItems.length) {
        const trimmed = maxItems ? allItems.slice(0, maxItems) : allItems;
        return mapFolderItemsToQueue(trimmed, zoneName, 5, user, station ?? rawClean, defaultSpotifyUserId);
      }
    }

    // Deezer bridge content
    if (!forceSpotify && (isDeezer || service === 'deezer' || /deezer/i.test(rawPath))) {
      const providerId = rawClean.split(':')[0] || 'deezer';
      const user = providerId.split('@')[1] ?? 'deezer';
      const sourcePath = pickSourcePath();
      const folderId = sourcePath
        .replace(/^spotify@[^:]+:/i, '')
        .replace(/^deezer@[^:]+:/i, '')
        .replace(/^spotify:/i, '')
        .replace(/^deezer:/i, '');
      if (/^track:/i.test(folderId)) {
        const trackId = folderId.split(':').slice(1).join(':');
        const track = await this.contentPort.getServiceTrack(providerId, user, `track:${trackId}`);
        if (track) {
          return mapFolderItemsToQueue([track], zoneName, 5, user, undefined, defaultSpotifyUserId);
        }
        this.log.debug('deezer queue track lookup failed', {
          providerId,
          folderId,
          trackId,
        });
      }
      const allItems: ContentFolderItem[] = [];
      const pageSize = 50;
      let offset = 0;
      let total = Number.MAX_SAFE_INTEGER;
      while (offset < total) {
        const folder = await this.contentPort.getServiceFolder(providerId, user, folderId, offset, pageSize);
        const items = folder?.items ?? [];
        if (items.length === 0) {
          break;
        }
        allItems.push(...items);
        total = Number.isFinite(folder?.totalitems) ? (folder as any).totalitems : Number.MAX_SAFE_INTEGER;
        offset += items.length;
        if (items.length < pageSize) {
          break;
        }
        if (maxItems && allItems.length >= maxItems) {
          break;
        }
        if (allItems.length >= 1000) {
          break;
        }
      }
      if (allItems.length) {
        const trimmed = maxItems ? allItems.slice(0, maxItems) : allItems;
        return mapFolderItemsToQueue(trimmed, zoneName, 5, user, station ?? rawClean, defaultSpotifyUserId);
      }
    }

    // Tidal bridge content
    if (!forceSpotify && (isTidal || service === 'tidal' || /tidal/i.test(rawPath))) {
      const providerId = rawClean.split(':')[0] || 'tidal';
      const user = providerId.split('@')[1] ?? 'tidal';
      const sourcePath = pickSourcePath();
      const folderId = sourcePath
        .replace(/^spotify@[^:]+:/i, '')
        .replace(/^tidal@[^:]+:/i, '')
        .replace(/^spotify:/i, '')
        .replace(/^tidal:/i, '');
      if (/^track:/i.test(folderId)) {
        const trackId = folderId.split(':').slice(1).join(':');
        const track = await this.contentPort.getServiceTrack(providerId, user, `track:${trackId}`);
        if (track) {
          return mapFolderItemsToQueue([track], zoneName, 5, user, undefined, defaultSpotifyUserId);
        }
        this.log.debug('tidal queue track lookup failed', {
          providerId,
          folderId,
          trackId,
        });
      }
      const allItems: ContentFolderItem[] = [];
      const pageSize = 50;
      let offset = 0;
      let total = Number.MAX_SAFE_INTEGER;
      while (offset < total) {
        const folder = await this.contentPort.getServiceFolder(providerId, user, folderId, offset, pageSize);
        const items = folder?.items ?? [];
        if (items.length === 0) {
          break;
        }
        allItems.push(...items);
        total = Number.isFinite(folder?.totalitems) ? (folder as any).totalitems : Number.MAX_SAFE_INTEGER;
        offset += items.length;
        if (items.length < pageSize) {
          break;
        }
        if (maxItems && allItems.length >= maxItems) {
          break;
        }
        if (allItems.length >= 1000) {
          break;
        }
      }
      if (allItems.length) {
        const trimmed = maxItems ? allItems.slice(0, maxItems) : allItems;
        return mapFolderItemsToQueue(trimmed, zoneName, 5, user, station ?? rawClean, defaultSpotifyUserId);
      }
    }

    // Spotify content
    const spotifyCandidate =
      forceSpotify || decoded.includes(':') ? decoded : rawClean;
    if (spotifyCandidate.startsWith('spotify@') || spotifyCandidate.startsWith('spotify:')) {
      const user = spotifyCandidate.startsWith('spotify@')
        ? parseSpotifyUser(spotifyCandidate)
        : defaultSpotifyUserId ?? 'nouser';
      const folderId = spotifyCandidate
        .replace(/^spotify@[^:]+:/i, '')
        .replace(/^spotify:/i, '');
      if (folderId.toLowerCase().startsWith('track:')) {
        const trackId = folderId.split(':').pop() ?? '';
        const track = await this.contentPort.getServiceTrack('spotify', user, trackId);
        if (track) {
          return mapFolderItemsToQueue([track], zoneName, 5, user, undefined, defaultSpotifyUserId);
        }
      }
      // Fetch full playlist/album in pages of 50.
      const allItems: ContentFolderItem[] = [];
      const pageSize = 50;
      let offset = 0;
      let total = Number.MAX_SAFE_INTEGER;
      while (offset < total) {
        const folder = await this.contentPort.getServiceFolder('spotify', user, folderId, offset, pageSize);
        const items = folder?.items ?? [];
        if (items.length === 0) {
          break;
        }
        allItems.push(...items);
        total = Number.isFinite(folder?.totalitems) ? (folder as any).totalitems : Number.MAX_SAFE_INTEGER;
        offset += items.length;
        if (items.length < pageSize) {
          break;
        }
        if (maxItems && allItems.length >= maxItems) {
          break;
        }
        if (allItems.length >= 1000) {
          break;
        }
      }
      if (allItems.length) {
        const trimmed = maxItems ? allItems.slice(0, maxItems) : allItems;
        return mapFolderItemsToQueue(trimmed, zoneName, 5, user, station ?? decoded, defaultSpotifyUserId);
      }
    }

    return [];
  }

  public async fillQueueInBackground(
    ctx: ZoneContext,
    resolvedTarget: string,
    zoneName: string,
    station: string | undefined,
    rawAudiopath: string | undefined,
    token: string,
  ): Promise<void> {
    try {
      const fullQueue = await this.buildQueueForUri(resolvedTarget, zoneName, station, rawAudiopath);
      if (!fullQueue.length) {
        return;
      }
      if (ctx.metadata.queueFillToken !== token) {
        return;
      }
      if (ctx.queue.items.length >= fullQueue.length) {
        return;
      }
      const current = ctx.queueController.current()?.audiopath ?? '';
      const normalizedCurrent = normalizeSpotifyAudiopath(current || '');
      const nextIndex = fullQueue.findIndex(
        (item) => normalizeSpotifyAudiopath(item.audiopath) === normalizedCurrent,
      );
      const startIndex = nextIndex >= 0 ? nextIndex : ctx.queueController.currentIndex();
      const prevShuffle = ctx.queue.shuffle;
      const prevRepeat = ctx.queue.repeat;
      ctx.queueController.setItems(fullQueue, startIndex);
      ctx.metadata.queueShuffled = false;
      ctx.queue.shuffle = prevShuffle;
      ctx.queue.repeat = prevRepeat;
      if (ctx.queue.shuffle) {
        this.reorderQueue(ctx, 'shuffle', { keepCurrent: true, shuffleUpcoming: true });
      }
      this.deps.notifier.notifyQueueUpdated(ctx.id, ctx.queue.items.length);
      this.log.debug('queue filled in background', {
        zoneId: ctx.id,
        items: ctx.queue.items.length,
        startIndex,
      });
    } catch (err) {
      this.log.debug('queue background fill failed', {
        zoneId: ctx.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  public async resolveTrackDuration(audiopath: string): Promise<number> {
    const match = audiopath.match(/^spotify@([^:]+):track:([^/?#]+)/i) ??
      audiopath.match(/^spotify:track:([^/?#]+)/i);
    if (!match) {
      return 0;
    }
    const user = match.length === 3 ? match[1] : '';
    const trackId = match.length === 3 ? match[2] : match[1];
    const track = await this.contentPort.getServiceTrack('spotify', user, trackId);
    if (track && typeof (track as any).duration === 'number') {
      const d = Math.round((track as any).duration);
      return d > 0 ? d : 0;
    }
    return 0;
  }

  public resolveQueueAuthorityFromItems(items: QueueItem[]): QueueAuthority | null {
    for (const item of items) {
      if (this.deps.isMusicAssistantAudiopath(item.audiopath)) {
        return 'musicassistant';
      }
      if (this.deps.isAppleMusicAudiopath(item.audiopath)) {
        return 'applemusic';
      }
      if (this.deps.isDeezerAudiopath(item.audiopath)) {
        return 'deezer';
      }
      if (this.deps.isTidalAudiopath(item.audiopath)) {
        return 'tidal';
      }
      if (this.deps.isSpotifyAudiopath(item.audiopath)) {
        return 'spotify';
      }
      if ((item.audiopath || '').toLowerCase().startsWith('airplay://')) {
        return 'airplay';
      }
    }
    return null;
  }

  public seekExistingQueueInternal(ctx: ZoneContext, target: string): boolean {
    if (!target || ctx.queue.items.length === 0) {
      return false;
    }
    const normalizedTarget = normalizeSpotifyAudiopath(target);
    const idx = ctx.queue.items.findIndex(
      (item) =>
        normalizeSpotifyAudiopath(item.audiopath) === normalizedTarget ||
        normalizeSpotifyAudiopath(item.unique_id) === normalizedTarget,
    );
    if (idx < 0) {
      return false;
    }
    // Only record the index change; actual seeking is handled via explicit HTTP commands.
    ctx.queueController.setCurrentIndex(idx);
    this.log.debug('queue seek requested; qindex updated', {
      zoneId: ctx.id,
      target,
      qindex: idx,
    });
    return true;
  }

  public reorderQueue(
    ctx: ZoneContext,
    mode: 'shuffle' | 'unshuffle',
    opts: { keepCurrent: boolean; shuffleUpcoming?: boolean },
  ): void {
    if (!ctx.queue.items.length) {
      return;
    }
    let reordered = ctx.queue.items.slice();
    const currentIndex = opts.keepCurrent ? ctx.queueController.currentIndex() : 0;
    if (mode === 'shuffle') {
      if (opts.keepCurrent) {
        if (opts.shuffleUpcoming) {
          const head = reordered.slice(0, currentIndex + 1);
          const tail = reordered.slice(currentIndex + 1);
          for (let i = tail.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [tail[i], tail[j]] = [tail[j], tail[i]];
          }
          reordered = head.concat(tail);
        } else {
          const current = ctx.queueController.current();
          if (!current) {
            return;
          }
          const currentItem = reordered[currentIndex];
          const rest = reordered.filter((_, idx) => idx !== currentIndex);
          for (let i = rest.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [rest[i], rest[j]] = [rest[j], rest[i]];
          }
          const insertAt = clamp(currentIndex, 0, rest.length);
          rest.splice(insertAt, 0, currentItem);
          reordered = rest;
        }
      } else {
        const pickIndex = Math.floor(Math.random() * reordered.length);
        const picked = reordered.splice(pickIndex, 1)[0];
        for (let i = reordered.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          [reordered[i], reordered[j]] = [reordered[j], reordered[i]];
        }
        reordered = [picked, ...reordered];
      }
    } else {
      if (opts.keepCurrent && opts.shuffleUpcoming) {
        const head = reordered.slice(0, currentIndex + 1);
        const tail = reordered.slice(currentIndex + 1).sort(
          (a, b) => (a.originalIndex ?? 0) - (b.originalIndex ?? 0),
        );
        reordered = head.concat(tail);
      } else {
        reordered = reordered.sort(
          (a, b) => (a.originalIndex ?? 0) - (b.originalIndex ?? 0),
        );
      }
    }
    if (opts.keepCurrent) {
      const current = ctx.queueController.current();
      if (!current) {
        return;
      }
      ctx.queueController.setItems(reordered, currentIndex);
    } else {
      ctx.queueController.setItems(reordered, 0);
    }
    ctx.metadata.queueShuffled = mode === 'shuffle';
    this.deps.applyPatch(ctx.id, {
      qindex: ctx.queueController.currentIndex(),
      plshuffle: ctx.queue.shuffle ? 1 : 0,
    });
    this.deps.notifier.notifyQueueUpdated(ctx.id, ctx.queue.items.length);
  }
}

function sanitizeAudiopathForOutput(audiopath: string): string {
  if (!audiopath) {
    return audiopath;
  }
  if (/^spotify@/i.test(audiopath)) {
    return `spotify:${audiopath.replace(/^spotify@[^:]+:/i, '')}`;
  }
  return audiopath;
}
