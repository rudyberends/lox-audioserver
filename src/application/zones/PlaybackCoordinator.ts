import type { ComponentLogger } from '@/shared/logging/logger';
import type { AudioManager, PlaybackMetadata, PlaybackSession, PlaybackSource, CoverArtPayload } from '@/application/playback/audioManager';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import type { QueueAuthority, ZoneContext } from '@/application/zones/internal/zoneTypes';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import type { InputsPort, MusicAssistantInputHandlers } from '@/ports/InputsPort';
import type { ContentPort } from '@/ports/ContentPort';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { NotifierPort } from '@/ports/NotifierPort';
import { decodeAudiopath, encodeAudiopath } from '@/domain/loxone/audiopath';
import {
  normalizeSpotifyAudiopath,
  sanitizeStation,
} from '@/application/zones/helpers/queueHelpers';
import {
  clampVolumeForZone,
  fallbackTitle,
  sanitizeTitle,
  clamp,
} from '@/application/zones/helpers/stateHelpers';
import { audioOutputSettings } from '@/ports/types/audioFormat';
import { computePreferredPlaybackSettings } from '@/application/playback/policies/OutputFormatPolicy';
import { buildPlaybackPlan } from '@/application/playback/buildPlaybackPlan';
import { executePlaybackPlan } from '@/application/playback/executePlaybackPlan';
import type { ProviderKind } from '@/application/playback/types/PlaybackPlan';
import { parseParentContext } from '@/application/zones/policies/ParentContextPolicy';
import { classifyIsRadio } from '@/application/zones/policies/RadioClassificationPolicy';
import { enrichMetadata } from '@/application/zones/metadata/MetadataEnricher';
import { buildQueueForRequest } from '@/application/zones/queue/QueueBuilder';
import { OutputRouter } from '@/application/zones/OutputRouter';
import { QueueController as ZoneQueueController } from '@/application/zones/QueueController';
import { AudioType } from '@/domain/loxone/enums';
import { type ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';
import {
  getMusicAssistantProviderId,
  setMusicAssistantProviderId,
  MUSIC_ASSISTANT_PROVIDER_DEFAULT,
} from '@/application/zones/internal/musicAssistantProvider';
import { ZoneRepository } from '@/application/zones/ZoneRepository';
import type { ConfigPort } from '@/ports/ConfigPort';

const IGNORED_PLAYER_ERROR_REASONS = new Set([
  'alert_stop',
  'input_stop',
  'reconfigure',
  'shutdown',
  'command_stop',
  'queue_empty',
  'queue_end',
  'airplay_forced_stop',
  'airplay_stop',
]);

const PLAYBACK_ERROR_ALIASES: Record<string, string> = {
  uri: 'invalid or missing playback URI',
  auth: 'authentication required',
  device: 'playback device unavailable',
  error: 'transport error',
  queue_invalid_next: 'next queue item unavailable',
  queue_next_failed: 'failed to start next queue item',
  'airplay no source': 'AirPlay source missing',
  'airplay engine not ready': 'AirPlay engine not ready',
  'airplay pcm not ready': 'AirPlay not ready',
  'airplay pcm stream unavailable': 'AirPlay stream unavailable',
  'airplay stream not ready': 'AirPlay stream not ready',
};

type PlaybackCoordinatorDeps = {
  zones: ZoneRepository;
  queueController: ZoneQueueController;
  outputRouter: OutputRouter;
  applyPatch: (zoneId: number, patch: Partial<LoxoneZoneState>, force?: boolean) => void;
  stopAlert: (zoneId: number) => Promise<void>;
  log: ComponentLogger;
  notifier: NotifierPort;
  inputsPort: InputsPort;
  audioHelpers: ZoneAudioHelpers;
  contentPort: ContentPort;
  configPort: ConfigPort;
  recentsManager: RecentsManager;
  audioManager: AudioManager;
};

export class PlaybackCoordinator {
  private readonly zoneRepo: ZoneRepository;
  private readonly queueController: ZoneQueueController;
  private readonly outputRouter: OutputRouter;
  private readonly applyPatch: (
    zoneId: number,
    patch: Partial<LoxoneZoneState>,
    force?: boolean,
  ) => void;
  private readonly stopAlert: (zoneId: number) => Promise<void>;
  private readonly log: ComponentLogger;
  private readonly notifier: NotifierPort;
  private readonly inputsPort: InputsPort;
  private readonly audioHelpers: ZoneAudioHelpers;
  private readonly contentPort: ContentPort;
  private readonly configPort: ConfigPort;
  private readonly recentsManager: RecentsManager;
  private readonly audioManager: AudioManager;
  private readonly musicAssistantInputHandlers: MusicAssistantInputHandlers = {
    startPlayback: (zoneId: number, label: string, source: PlaybackSource, metadata?: PlaybackMetadata) => {
      const ctx = this.zoneRepo.get(zoneId);
      if (!ctx || (ctx.activeInput && ctx.activeInput !== 'musicassistant')) {
        return;
      }
      this.playInputSource(zoneId, label, source, metadata);
    },
    stopPlayback: (zoneId: number) => {
      const ctx = this.zoneRepo.get(zoneId);
      if (!ctx || (ctx.activeInput && ctx.activeInput !== 'musicassistant')) {
        return;
      }
      this.stopInputSource(zoneId);
    },
    updateMetadata: (zoneId: number, metadata: Partial<PlaybackMetadata>) => {
      const ctx = this.zoneRepo.get(zoneId);
      if (!ctx || (ctx.activeInput && ctx.activeInput !== 'musicassistant')) {
        return;
      }
      this.updateInputMetadata(zoneId, metadata);
    },
    updateVolume: (zoneId: number, volume: number) => {
      const ctx = this.zoneRepo.get(zoneId);
      if (!ctx || (ctx.activeInput && ctx.activeInput !== 'musicassistant')) {
        return;
      }
      this.updateInputVolume(zoneId, volume);
    },
    updateTiming: (zoneId: number, elapsed: number, duration: number) => {
      const ctx = this.zoneRepo.get(zoneId);
      if (!ctx || (ctx.activeInput && ctx.activeInput !== 'musicassistant')) {
        return;
      }
      this.updateInputTiming(zoneId, elapsed, duration);
    },
  };

  constructor(deps: PlaybackCoordinatorDeps) {
    this.zoneRepo = deps.zones;
    this.queueController = deps.queueController;
    this.outputRouter = deps.outputRouter;
    this.applyPatch = deps.applyPatch;
    this.stopAlert = deps.stopAlert;
    this.log = deps.log;
    this.notifier = deps.notifier;
    this.inputsPort = deps.inputsPort;
    this.audioHelpers = deps.audioHelpers;
    this.contentPort = deps.contentPort;
    this.configPort = deps.configPort;
    this.recentsManager = deps.recentsManager;
    this.audioManager = deps.audioManager;
  }

  public getMusicAssistantInputHandlers(): MusicAssistantInputHandlers {
    return this.musicAssistantInputHandlers;
  }

  /** Keep Music Assistant provider detection in sync with the configured bridge. */
  public refreshMusicAssistantProviderId(): void {
    try {
      const providerId = this.inputsPort.getMusicAssistantProviderId();
      setMusicAssistantProviderId(providerId);
    } catch {
      setMusicAssistantProviderId(MUSIC_ASSISTANT_PROVIDER_DEFAULT);
    }
  }

  private getVolumeOrigin(): string {
    const stack = new Error().stack;
    if (!stack) {
      return 'unknown';
    }
    // Keep the first few frames so we can pinpoint which caller drives a volume_set.
    const lines = stack
      .split('\n')
      .slice(1, 6)
      .map((l) => l.trim().replace(/^at\s+/, ''))
      .filter(Boolean);
    return lines.join(' | ') || 'unknown';
  }

  public playInputSource(
    zoneId: number,
    label: string,
    playbackSource: PlaybackSource,
    metadata?: PlaybackMetadata,
  ): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    const normalized = label.toLowerCase();
    if (!['airplay', 'spotify', 'musicassistant', 'linein'].includes(normalized)) {
      return;
    }
    const mode = normalized as ZoneContext['inputMode'];
    // Avoid re-dispatching outputs when the same input/track is already playing.
    if (metadata?.audiopath && this.isActiveInput(ctx, mode) && this.isSameAudiopath(ctx, metadata.audiopath)) {
      const nextPipe = playbackSource?.kind === 'pipe'
        ? (playbackSource as { stream?: NodeJS.ReadableStream }).stream
        : null;
      const currentState = ctx.player.getState();
      const currentPipe =
        currentState.playbackSource?.kind === 'pipe'
          ? (currentState.playbackSource as { stream?: NodeJS.ReadableStream }).stream
          : null;
      if (nextPipe && nextPipe !== currentPipe) {
        // New pipe stream for the same audiopath (e.g., line-in reconnect): restart input.
      } else {
        this.updateInputMetadata(zoneId, metadata);
        return;
      }
    }
    const prevInput = ctx.inputMode;
    const prevAudiopath = ctx.state.audiopath;
    this.setInputMode(ctx, mode);
    if (prevInput === 'linein' && mode !== 'linein') {
      const inputId = this.audioHelpers.parseLineInInputId(prevAudiopath);
      if (inputId) {
        this.log.info('line-in input cleared on input switch', {
          zoneId: ctx.id,
          from: prevInput,
          to: mode,
          inputId,
        });
        this.inputsPort.requestLineInStop(inputId);
      }
    }
    this.stopExternalInputSessions(zoneId, prevInput, mode);
    if (mode !== 'spotify') {
      this.stopSpotifyOutputs(ctx.outputs);
    }
    ctx.queue.authority =
      mode === 'airplay'
        ? 'airplay'
        : mode === 'spotify'
          ? 'spotify'
          : mode === 'musicassistant'
            ? 'musicassistant'
            : mode === 'linein'
              ? 'local'
              : 'local';
    ctx.inputAdapter.playInput(label, playbackSource, metadata);
  }

  public stopInputSource(zoneId: number): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    this.setInputMode(ctx, null);
    ctx.player.stop('input_stop');
  }

  public pauseInputSource(zoneId: number): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    if (ctx.activeInput && ctx.activeInput !== 'spotify') {
      this.stopSpotifyOutputs(ctx.outputs);
    }
    ctx.player.pause();
  }

  public resumeInputSource(zoneId: number): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    if (ctx.activeInput && ctx.activeInput !== 'spotify') {
      this.stopSpotifyOutputs(ctx.outputs);
    }
    ctx.player.resume();
  }

  public updateInputMetadata(zoneId: number, metadata: Partial<PlaybackMetadata>): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    const allowedInputs = new Set(['spotify', 'airplay', 'musicassistant', 'linein']);
    if (ctx.activeInput && !allowedInputs.has(ctx.activeInput)) {
      return;
    }
    ctx.player.updateMetadata(metadata as PlaybackMetadata);
    const didSeek =
      ctx.inputMode === 'musicassistant' && metadata.audiopath
        ? this.queueController.seekExistingQueueInternal(ctx, metadata.audiopath)
        : false;

    // Propagate richer metadata into the current queue item so recents/queue
    // can retain album/artist/cover details (especially for Music Assistant streams).
    const current = ctx.queueController.current();
    if (current) {
      let changed = false;
      const assign = (key: 'title' | 'artist' | 'album' | 'coverurl' | 'audiopath', value?: string) => {
        const trimmed = typeof value === 'string' ? value.trim() : '';
        if (trimmed && current[key] !== trimmed) {
          current[key] = trimmed;
          changed = true;
        }
      };

      assign('title', metadata.title);
      assign('artist', metadata.artist);
      assign('album', metadata.album);
      assign('coverurl', metadata.coverurl as string | undefined);
      assign('audiopath', metadata.audiopath);

      if (changed) {
        void this.recentsManager.record(zoneId, current);
      }
    }

    const patch: Partial<LoxoneZoneState> = {};
    const assignPatch = (key: keyof Pick<LoxoneZoneState, 'title' | 'artist' | 'album' | 'coverurl' | 'audiopath'>, value?: string) => {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (!trimmed) {
        return;
      }
      patch[key] = trimmed as any;
    };
    assignPatch('title', metadata.title ? sanitizeTitle(metadata.title, fallbackTitle(ctx.state.title, ctx.name)) : undefined);
    assignPatch('artist', metadata.artist);
    assignPatch('album', metadata.album);
    assignPatch('coverurl', metadata.coverurl as string | undefined);
    assignPatch('audiopath', metadata.audiopath);
    if (metadata.coverurl && typeof ctx.state.icontype === 'number') {
      patch.icontype = undefined;
    }
    if (metadata.coverurl) {
      patch.audiotype = 1;
    }
    if (typeof metadata.duration === 'number' && metadata.duration > 0) {
      patch.duration = Math.round(metadata.duration);
    } else if (
      metadata.audiopath &&
      current &&
      normalizeSpotifyAudiopath(metadata.audiopath) === normalizeSpotifyAudiopath(current.audiopath) &&
      typeof current.duration === 'number' &&
      current.duration > 0
    ) {
      patch.duration = Math.round(current.duration);
    }
    if (didSeek && current) {
      patch.qindex = ctx.queueController.currentIndex();
      patch.qid = current.unique_id;
    }
    if (ctx.queue.authority) {
      patch.queueAuthority = ctx.queue.authority;
    }
    if (Object.keys(patch).length > 0) {
      this.applyPatch(zoneId, patch);
    }
  }

  public updateRadioMetadata(zoneId: number, metadata: { title: string; artist: string }): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    if (ctx.state.mode !== 'play' || !this.audioHelpers.isRadioAudiopath(ctx.state.audiopath, ctx.state.audiotype)) {
      return;
    }
    const patch: Partial<LoxoneZoneState> = {};
    if (metadata.title) {
      patch.title = sanitizeTitle(metadata.title, fallbackTitle(ctx.state.title, ctx.name));
    }
    const artist = metadata.artist ?? '';
    patch.artist = artist;
    if (artist.trim()) {
      if (ctx.state.station) {
        ctx.metadata.radioStationFallback = ctx.state.station;
        patch.station = ctx.state.station;
      }
    } else if (!ctx.state.station) {
      const fallback = typeof ctx.metadata.radioStationFallback === 'string'
        ? ctx.metadata.radioStationFallback
        : '';
      if (fallback) {
        patch.station = fallback;
      }
    }
    if (Object.keys(patch).length > 0) {
      this.applyPatch(zoneId, patch);
    }
  }

  public updateInputCover(zoneId: number, cover?: CoverArtPayload): string | undefined {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return undefined;
    }
    const allowedInputs = new Set(['spotify', 'airplay', 'musicassistant']);
    if (ctx.activeInput && !allowedInputs.has(ctx.activeInput)) {
      return undefined;
    }
    const relativePath = ctx.player.updateCover(cover) ?? '';
    const baseUrl =
      relativePath && cover ? this.buildAbsoluteCoverUrl(relativePath) : '';
    const coverUrl = baseUrl ? `${baseUrl}?t=${Date.now()}` : '';
    const current = ctx.queueController.current();
    if (current) {
      current.coverurl = coverUrl;
    }
    return coverUrl || undefined;
  }

  public updateInputVolume(zoneId: number, volume: number): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    const allowedInputs = new Set(['spotify', 'airplay', 'musicassistant']);
    if (ctx.activeInput && !allowedInputs.has(ctx.activeInput)) {
      return;
    }
    const level = clampVolumeForZone(ctx.config, volume);
    ctx.player.setVolume(level);
  }

  public updateInputTiming(zoneId: number, elapsed: number, duration: number): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    const safeDuration = Math.max(0, Math.round(duration));
    const safeElapsed = Math.max(0, Math.round(elapsed));
    const boundedElapsed =
      safeDuration > 0 ? Math.min(safeElapsed, safeDuration) : safeElapsed;
    ctx.player.updateTiming(boundedElapsed, safeDuration);
  }

  public async playContent(
    zoneId: number,
    uri: string,
    type: string,
    metadata?: PlaybackMetadata,
  ): Promise<void> {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }

    const parentContext = parseParentContext(uri, {
      isAppleMusicProvider: (providerId: string) => this.contentPort.isAppleMusicProvider(providerId),
      isDeezerProvider: (providerId: string) => this.contentPort.isDeezerProvider(providerId),
      isTidalProvider: (providerId: string) => this.contentPort.isTidalProvider(providerId),
    });
    const isAppleMusicUri = this.audioHelpers.isAppleMusicAudiopath(uri);
    const isDeezerUri = this.audioHelpers.isDeezerAudiopath(uri);
    const isTidalUri = this.audioHelpers.isTidalAudiopath(uri);
    let resolvedTarget =
      parentContext?.parent ??
      (isAppleMusicUri || isDeezerUri || isTidalUri ? uri : decodeAudiopath(uri));
    let stationUri = parentContext?.parent ? normalizeSpotifyAudiopath(parentContext.parent) : '';
    let normalizedTarget = normalizeSpotifyAudiopath(resolvedTarget);
    const isMusicAssistantInitial = this.audioHelpers.isMusicAssistantAudiopath(uri) || this.audioHelpers.isMusicAssistantAudiopath(resolvedTarget);
    let queueAudiopath = isMusicAssistantInitial ? normalizeSpotifyAudiopath(uri) : normalizedTarget;
    if (isMusicAssistantInitial && parentContext?.parent) {
      const providerPrefix = queueAudiopath.split(':')[0] || getMusicAssistantProviderId();
      const parentType = /playlist/i.test(parentContext.parent)
        ? 'playlist'
        : /album/i.test(parentContext.parent)
          ? 'album'
          : /artist/i.test(parentContext.parent)
            ? 'artist'
            : 'track';
      const wrappedParent = encodeAudiopath(parentContext.parent, parentType, providerPrefix);
      resolvedTarget = wrappedParent;
      normalizedTarget = normalizeSpotifyAudiopath(resolvedTarget);
      stationUri = normalizeSpotifyAudiopath(resolvedTarget);
      queueAudiopath = normalizeSpotifyAudiopath(uri);
    }
    const isMusicAssistant = this.audioHelpers.isMusicAssistantAudiopath(queueAudiopath) || this.audioHelpers.isMusicAssistantAudiopath(resolvedTarget);
    const isAppleMusic = this.audioHelpers.isAppleMusicAudiopath(queueAudiopath) || this.audioHelpers.isAppleMusicAudiopath(resolvedTarget);
    const isDeezer = this.audioHelpers.isDeezerAudiopath(queueAudiopath) || this.audioHelpers.isDeezerAudiopath(resolvedTarget);
    const isTidal = this.audioHelpers.isTidalAudiopath(queueAudiopath) || this.audioHelpers.isTidalAudiopath(resolvedTarget);
    const nextInput: ZoneContext['inputMode'] =
      this.audioHelpers.isSpotifyAudiopath(queueAudiopath)
        ? 'spotify'
        : isMusicAssistant
          ? 'musicassistant'
          : 'queue';
    if (isMusicAssistant && type === 'serviceplay' && this.isActiveInput(ctx, 'musicassistant')) {
      if (this.isSameAudiopath(ctx, queueAudiopath)) {
        this.log.debug('playContent ignored; musicassistant already playing target', {
          zoneId,
          target: normalizeSpotifyAudiopath(queueAudiopath),
        });
        return;
      }
    }
    this.stopExternalInputSessions(zoneId, ctx.inputMode ?? null, nextInput);
    let stationValue =
      parentContext?.parent && isMusicAssistant
        ? parentContext.parent
        : parentContext?.parent
          ? sanitizeStation(parentContext.parent, normalizedTarget)
          : stationUri;
    let isRadio = classifyIsRadio({ uri, resolvedTarget, metadata });
    if (isRadio && !stationValue && metadata?.station?.trim()) {
      stationValue = metadata.station.trim();
    }
    if (isRadio && !stationValue && metadata?.title?.trim()) {
      stationValue = metadata.title.trim();
    }
    if (isRadio && !stationValue) {
      stationValue = this.audioHelpers.deriveRadioStationLabel(resolvedTarget) ?? this.audioHelpers.deriveRadioStationLabel(uri) ?? '';
    }
    if (isRadio && stationValue?.trim() && !this.audioHelpers.isLikelyHostLabel(stationValue)) {
      ctx.metadata.radioStationFallback = stationValue.trim();
    }
    this.log.info('playContent', {
      zoneId,
      type,
      uri,
      resolvedTarget,
      normalizedTarget,
      station: stationUri,
      hasParentContext: Boolean(parentContext),
    });

    // If this looks like a queue item selection (no parent context) and the item already
    // exists in our queue, just seek to it instead of rebuilding the queue.
    if (!parentContext && ctx.state.mode !== 'stop' && this.queueController.seekExistingQueueInternal(ctx, normalizedTarget)) {
      const current = ctx.queueController.current();
      if (!current) {
        this.log.warn('queue seek failed; no current item', { zoneId, target: normalizedTarget });
        return;
      }
      const session = await this.startQueuePlayback(ctx, current.audiopath, {
        title: current.title || ctx.name,
        artist: current.artist || '',
        album: current.album || '',
        coverurl: current.coverurl,
        duration: current.duration,
        audiopath: current.audiopath,
        station: current.station,
        stationIndex: ctx.queueController.currentIndex(),
        isRadio: this.audioHelpers.isRadioAudiopath(current.audiopath, current.audiotype),
      });
      if (session) {
        void this.recentsManager.record(zoneId, current);
        if (!this.audioHelpers.isRadioAudiopath(current.audiopath, current.audiotype)) {
          this.notifier.notifyQueueUpdated(zoneId, ctx.queue.items.length);
        }
      } else {
        this.log.warn('playback skipped; no playable source resolved', {
          zoneId,
          audiopath: current.audiopath,
        });
        const shouldStayOnline =
          this.audioHelpers.isMusicAssistantAudiopath(current.audiopath) ||
          this.audioHelpers.isSpotifyAudiopath(current.audiopath) ||
          this.audioHelpers.isAppleMusicAudiopath(current.audiopath);
        this.applyPatch(
          zoneId,
          shouldStayOnline
            ? { mode: 'stop', clientState: 'on', power: 'on' }
            : { mode: 'stop', clientState: 'off', power: 'off' },
        );
        this.dispatchOutputs(ctx, ctx.outputs, 'stop', null);
      }
      return;
    }

    const queueSourcePath =
      isAppleMusic && parentContext?.parent ? parentContext.parent : uri;
    const targetForQueueBuild = normalizeSpotifyAudiopath(resolvedTarget || '');
    const shouldLimitQueueBuild = Boolean(
      targetForQueueBuild &&
      /(library-)?(album|playlist|artist):/i.test(targetForQueueBuild),
    );
    const queueBuildLimit = shouldLimitQueueBuild ? 50 : undefined;
    const isLineIn = type === 'linein';
    const queueBuild = await buildQueueForRequest({
      request: {
        zoneId,
        zoneName: ctx.name,
        uri,
        resolvedTarget,
        stationUri: stationUri || undefined,
        stationValue,
        queueSourcePath,
        queueAudiopath,
        parentContext,
        isRadio,
        isAppleMusic,
        isDeezer,
        isTidal,
        isMusicAssistant,
        isLineIn,
        queueBuildLimit,
        startIndexHint: parentContext?.startIndex,
        startItemHint: parentContext?.startItem,
      },
      queueController: this.queueController,
      content: this.contentPort,
      audioHelpers: this.audioHelpers,
      resolveMetadata: () => enrichMetadata({
        content: this.contentPort,
        uri,
        queueAudiopath,
        parentContext,
        isRadio,
        isMusicAssistant,
        isAppleMusic,
        stationValue,
        incoming: metadata,
      }),
    });
    this.log.debug('queue build resolved', {
      zoneId,
      queueSourcePath,
      resolvedTarget,
      expandedCount: queueBuild.expandedCount,
      isAppleMusic,
      isMusicAssistant,
    });
    const queueItems = queueBuild.items;
    const clampedIndex = queueBuild.startIndex;
    const enrichedMetadata = queueBuild.metadata;
    const bridgeProvider =
      this.audioHelpers.resolveBridgeProvider(queueAudiopath) ??
      this.audioHelpers.resolveBridgeProvider(resolvedTarget) ??
      this.audioHelpers.resolveBridgeProvider(uri);
    const forceLocalQueue =
      isAppleMusic ||
      (this.audioHelpers.isSpotifyAudiopath(queueAudiopath) && Boolean(bridgeProvider && bridgeProvider !== 'spotify'));
    ctx.queue.authority = forceLocalQueue
      ? 'local'
      : isMusicAssistant
        ? 'musicassistant'
        : isAppleMusic
          ? 'applemusic'
          : isDeezer
            ? 'deezer'
            : isTidal
              ? 'tidal'
              : this.audioHelpers.isSpotifyAudiopath(queueAudiopath)
                ? 'spotify'
                : 'local';
    this.log.debug('queue rebuilt', {
      zoneId: ctx.id,
      items: queueItems.length,
      startIndex: clampedIndex,
      target: queueItems[clampedIndex]?.audiopath,
      authority: ctx.queue.authority,
    });
    ctx.queueController.setItems(queueItems, clampedIndex);
    ctx.metadata.queueShuffled = false;
    const pendingShuffle = ctx.metadata.pendingShuffle;
    if (typeof pendingShuffle === 'boolean') {
      ctx.queue.shuffle = pendingShuffle;
      delete ctx.metadata.pendingShuffle;
      this.applyPatch(zoneId, { plshuffle: pendingShuffle ? 1 : 0 });
    } else {
      ctx.queue.shuffle = false;
    }
    ctx.queue.repeat = 0;
    if (ctx.queue.shuffle) {
      const preserveCurrent = typeof pendingShuffle !== 'boolean';
      this.reorderQueue(ctx, 'shuffle', {
        keepCurrent: preserveCurrent,
        shuffleUpcoming: preserveCurrent,
      });
      if (!preserveCurrent) {
        ctx.queueController.setCurrentIndex(0);
        this.applyPatch(zoneId, { qindex: 0 });
      }
    }
    if (queueBuild.shouldFillInBackground && queueBuild.fillArgs) {
      const token = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
      ctx.metadata.queueFillToken = token;
      void this.queueController.fillQueueInBackground(
        ctx,
        queueBuild.fillArgs.resolvedTarget,
        ctx.name,
        queueBuild.fillArgs.stationUri || undefined,
        queueBuild.fillArgs.queueSourcePath,
        token,
      );
    }

    const current = ctx.queueController.current();
    if (!current) {
      this.log.warn('playback skipped; empty queue after build', { zoneId, uri });
      return;
    }

    const stationForPlayback =
      isMusicAssistant && current.station ? current.station : stationValue;
    const session = await this.startQueuePlayback(ctx, current.audiopath, {
      title: enrichedMetadata?.title?.trim() || current.title || ctx.name,
      artist: enrichedMetadata?.artist?.trim() || current.artist || '',
      album: enrichedMetadata?.album?.trim() || current.album || '',
      coverurl: enrichedMetadata?.coverurl || current.coverurl,
      duration: typeof enrichedMetadata?.duration === 'number' ? enrichedMetadata.duration : current.duration,
      audiopath: enrichedMetadata?.audiopath,
      trackId: enrichedMetadata?.trackId,
      station: stationForPlayback,
      stationIndex: ctx.queueController.currentIndex(),
      isRadio,
    });
    if (session) {
      void this.recentsManager.record(zoneId, current);
      if (!isRadio) {
        this.notifier.notifyQueueUpdated(zoneId, ctx.queue.items.length);
      }
    } else {
      this.log.warn('playback skipped; no playable source resolved', {
        zoneId,
        audiopath: current.audiopath,
      });
      const shouldStayOnline =
        this.audioHelpers.isMusicAssistantAudiopath(current.audiopath) ||
        this.audioHelpers.isSpotifyAudiopath(current.audiopath) ||
        this.audioHelpers.isAppleMusicAudiopath(current.audiopath);
      this.applyPatch(
        zoneId,
        shouldStayOnline
          ? { mode: 'stop', clientState: 'on', power: 'on' }
          : { mode: 'stop', clientState: 'off', power: 'off' },
      );
      this.dispatchOutputs(ctx, ctx.outputs, 'stop', null);
    }
  }

  public async startQueuePlayback(
    ctx: ZoneContext,
    audiopath: string,
    metadata?: PlaybackMetadata,
  ): Promise<PlaybackSession | null> {
    // Apply preferred output from the primary target output so we can resample/format accordingly.
    const outputTargets =
      ctx.activeOutput !== null
        ? ctx.outputs.filter((output) => output.type === ctx.activeOutput)
        : this.selectPlayOutputs(ctx.outputs, null);
    const latencyMs = outputTargets
      .map((output) => output.getLatencyMs?.())
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      .reduce((max, value) => Math.max(max, value), 0);
    ctx.player.setEndGuardMs(latencyMs);
    const isRadio = this.audioHelpers.isRadioAudiopath(audiopath);
    const settings = computePreferredPlaybackSettings({
      zoneId: ctx.id,
      zoneName: ctx.name,
      audiopath,
      isRadio,
      queueAuthority: ctx.queue.authority,
      outputs: ctx.outputs,
      activeOutputType: ctx.activeOutput,
      defaults: audioOutputSettings,
    });
    const isSpotify = this.audioHelpers.isSpotifyAudiopath(audiopath);
    const isMusicAssistant = this.audioHelpers.isMusicAssistantAudiopath(audiopath);
    const isAppleMusic = this.audioHelpers.isAppleMusicAudiopath(audiopath);
    const isDeezer = this.audioHelpers.isDeezerAudiopath(audiopath);
    const isTidal = this.audioHelpers.isTidalAudiopath(audiopath);
    const nextInput: ZoneContext['inputMode'] =
      isSpotify
        ? 'spotify'
        : isMusicAssistant
          ? 'musicassistant'
          : 'queue';
    const prevInput = ctx.inputMode;
    this.setInputMode(ctx, nextInput);
    this.stopExternalInputSessions(ctx.id, prevInput, nextInput);
    if (!isSpotify) {
      this.stopSpotifyOutputs(ctx.outputs);
    }
    const enrichedMetadata =
      metadata && metadata.audiopath
        ? metadata
        : { ...(metadata ?? { title: '', artist: '', album: '' }), audiopath };
    const provider: ProviderKind = isAppleMusic
      ? 'applemusic'
      : isDeezer
        ? 'deezer'
        : isTidal
          ? 'tidal'
          : null;
    const plan = buildPlaybackPlan({
      ctx,
      audiopath,
      metadata: enrichedMetadata,
      isRadio,
      preferredSettings: settings,
      classification: { isSpotify, isMusicAssistant, provider },
    });
    const session = await executePlaybackPlan({
      ctx,
      plan,
      content: this.contentPort,
      inputs: this.inputsPort,
      log: this.log,
      audioManager: this.audioManager,
    });
    if (!session) {
      if (plan.playExternalLabel === 'musicassistant') {
        this.handlePlaybackError(ctx.id, 'music assistant stream unavailable', 'output');
        this.log.warn('music assistant stream not ready; skipping playback', {
          zoneId: ctx.id,
        });
      } else if (plan.provider === 'applemusic') {
        this.handlePlaybackError(ctx.id, 'apple music stream unavailable', 'output');
        this.log.warn('apple music stream not ready; skipping playback', { zoneId: ctx.id });
      } else if (plan.provider === 'deezer') {
        this.handlePlaybackError(ctx.id, 'deezer stream unavailable', 'output');
        this.log.warn('deezer stream not ready; skipping playback', { zoneId: ctx.id });
      } else if (plan.provider === 'tidal') {
        this.handlePlaybackError(ctx.id, 'tidal stream unavailable', 'output');
        this.log.warn('tidal stream not ready; skipping playback', { zoneId: ctx.id });
      }
    }
    return session;
  }

  public handleCommand(zoneId: number, command: string, payload?: string): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    const mode = ctx.inputMode ?? null;
    switch (command) {
      case 'play':
      case 'resume':
        {
          if (mode === 'airplay') {
            this.inputsPort.remoteControl(zoneId, 'Play');
            break;
          }
          if (mode === 'musicassistant') {
            void this.inputsPort.playerCommand(zoneId, 'play');
            const session = ctx.player.resume();
            this.dispatchOutputs(ctx, ctx.outputs, 'resume', session ?? ctx.player.getSession());
            this.applyPatch(zoneId, { mode: 'play', clientState: 'on', power: 'on' });
            break;
          }
          const session = ctx.player.resume();
          this.dispatchOutputs(ctx, ctx.outputs, 'resume', session ?? ctx.player.getSession());
          this.applyPatch(zoneId, { mode: 'play', clientState: 'on', power: 'on' });
        }
        break;
      case 'pause':
        {
          if (mode === 'airplay') {
            this.inputsPort.remoteControl(zoneId, 'Pause');
            this.applyPatch(zoneId, { mode: 'pause', clientState: 'on', power: 'on' });
            break;
          }
          if (mode === 'musicassistant') {
            void this.inputsPort.playerCommand(zoneId, 'pause');
            const session = ctx.player.pause();
            this.dispatchOutputs(ctx, ctx.outputs, 'pause', session ?? ctx.player.getSession());
            this.applyPatch(zoneId, { mode: 'pause', clientState: 'on', power: 'on' });
            break;
          }
          const session = ctx.player.pause();
          this.dispatchOutputs(ctx, ctx.outputs, 'pause', session ?? ctx.player.getSession());
          this.applyPatch(zoneId, { mode: 'pause', clientState: 'on', power: 'on' });
        }
        break;
      case 'stop':
      case 'off':
        {
          if (mode === 'airplay') {
            this.inputsPort.remoteControl(zoneId, 'Stop');
            this.setInputMode(ctx, null);
            break;
          }
          if (mode === 'musicassistant') {
            void this.inputsPort.playerCommand(zoneId, 'stop');
            const session = ctx.player.stop('command_stop');
            this.dispatchOutputs(ctx, ctx.outputs, 'stop', session ?? ctx.player.getSession());
            this.setInputMode(ctx, null);
            break;
          }
          const session = ctx.player.stop('command_stop');
          this.dispatchOutputs(ctx, ctx.outputs, 'stop', session ?? ctx.player.getSession());
          this.setInputMode(ctx, null);
        }
        break;
      case 'position': {
        // Do not drive outputs from here; seeking is handled via dedicated HTTP endpoints.
        const posSeconds = Number(payload);
        if (!Number.isFinite(posSeconds) || posSeconds < 0) {
          break;
        }
        if (!this.isQueueDriven(mode)) {
          break;
        }
        if (mode === 'musicassistant') {
          void this.inputsPort.playerCommand(zoneId, 'seek', { position: posSeconds });
          break;
        }
        const session = ctx.player.getSession();
        const duration = session?.duration ?? ctx.state.duration ?? 0;
        const clamped = duration > 0 ? Math.min(posSeconds, duration) : posSeconds;
        ctx.player.updateTiming(Math.round(clamped), duration);
        this.log.debug('position command ignored for outputs (manual seek endpoint only)', {
          zoneId,
          requestedSeconds: posSeconds,
          clampedSeconds: clamped,
        });
        break;
      }
      case 'volume':
      case 'volume_set': {
        const vol = Number(payload);
        if (Number.isFinite(vol)) {
          const current = ctx.state.volume ?? 0;
          const isRelative = typeof payload === 'string' && /^[+-]/.test(payload);
          const maxVol =
            typeof ctx.config.volumes?.maxVolume === 'number' && ctx.config.volumes.maxVolume > 0
              ? ctx.config.volumes.maxVolume
              : 100;
          const step =
            typeof ctx.config.volumes?.volstep === 'number' && ctx.config.volumes.volstep > 0
              ? ctx.config.volumes.volstep
              : null;
          let target = clamp(isRelative ? current + vol : vol, 0, maxVol);
          if (step) {
            if (isRelative) {
              if (target > current) {
                target = Math.min(maxVol, Math.ceil(target / step) * step);
              } else if (target < current) {
                target = Math.max(0, Math.floor(target / step) * step);
              } else {
                target = current;
              }
            } else {
              target = clamp(Math.round(target / step) * step, 0, maxVol);
            }
          }
          const logContext: Record<string, unknown> = { zoneId, command, payload, target };
          if (this.log.isEnabled('spam')) {
            logContext.origin = this.getVolumeOrigin();
          }
          this.log.spam('zone volume command', logContext);
          if (mode === 'airplay') {
            this.inputsPort.remoteVolume(zoneId, target);
          }
          if (mode === 'musicassistant') {
            void this.inputsPort.playerCommand(zoneId, 'volume_set', {
              volume_level: target,
            });
          }
          // Apply locally and push to outputs immediately so repeated relative commands
          // use the updated level even if input callbacks lag.
          ctx.player.setVolume(target);
          this.applyPatch(zoneId, { volume: target });
          this.dispatchVolume(ctx, ctx.outputs, target);
        }
        break;
      }
      case 'queueplus':
        if (mode === 'airplay') {
          this.inputsPort.remoteControl(zoneId, 'Next');
          break;
        }
        if (mode === 'musicassistant') {
          void this.inputsPort.playerCommand(zoneId, 'next');
          break;
        }
        if (!this.isQueueDriven(mode)) {
          break;
        }
        if (!this.dispatchQueueStep(ctx, ctx.outputs, 1)) {
          if (this.isLocalQueueAuthority(ctx.queue.authority)) {
            this.stepQueue(zoneId, 1);
          }
        }
        break;
      case 'queueminus':
        if (mode === 'airplay') {
          this.inputsPort.remoteControl(zoneId, 'Previous');
          break;
        }
        if (mode === 'musicassistant') {
          void this.inputsPort.playerCommand(zoneId, 'previous');
          break;
        }
        if (!this.isQueueDriven(mode)) {
          break;
        }
        if (!this.dispatchQueueStep(ctx, ctx.outputs, -1)) {
          if (this.isLocalQueueAuthority(ctx.queue.authority)) {
            this.stepQueue(zoneId, -1);
          }
        }
        break;
      case 'shuffle': {
        const normalized =
          typeof payload === 'string' ? payload.trim().toLowerCase() : '';
        let enabled: boolean | null = null;
        if (['enable', 'on', '1', 'true'].includes(normalized)) {
          enabled = true;
        } else if (['disable', 'off', '0', 'false'].includes(normalized)) {
          enabled = false;
        }
        const next =
          enabled ?? !ctx.queue.shuffle;
        this.queueController.setShuffle(zoneId, next);
        break;
      }
      case 'repeat': {
        const normalized =
          typeof payload === 'string' ? payload.trim().toLowerCase() : '';
        let next: number | null = null;
        if (normalized) {
          if (['off', 'none', '0'].includes(normalized)) {
            next = 0;
          } else if (['all', 'queue', '1'].includes(normalized)) {
            next = 1;
          } else if (['one', 'track', '3'].includes(normalized)) {
            next = 3;
          }
        }
        if (next === null) {
          const current = ctx.queue.repeat ?? 0;
          if (current === 0) {
            next = 1;
          } else if (current === 1) {
            next = 3;
          } else {
            next = 0;
          }
        }
        this.applyPatch(zoneId, { plrepeat: next });
        ctx.queue.repeat = next;
        break;
      }
      default:
        break;
    }
  }

  public updateOutputState(
    zoneId: number,
    state: {
      status?: 'playing' | 'paused' | 'stopped';
      position?: number;
      duration?: number;
      uri?: string;
    },
  ): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    if (ctx.alert) {
      // Ignore output updates while an alert is active to avoid clobbering alert metadata.
      return;
    }
    const patch: Partial<LoxoneZoneState> = {};
    if (state.status === 'paused' || state.status === 'stopped') {
      ctx.outputTimingActive = false;
      ctx.lastOutputTimingAt = 0;
    }
    if (
      state.status === 'stopped' &&
      typeof state.position === 'number' &&
      typeof state.duration === 'number' &&
      state.duration > 0 &&
      ctx.player.getState().mode === 'playing'
    ) {
      const position = Math.round(state.position);
      const duration = Math.round(state.duration);
      if (position >= Math.max(0, duration - 1)) {
        // Force end-of-track even with output latency guard.
        ctx.player.setEndGuardMs(0);
        ctx.player.updateTiming(duration, duration);
      }
    }
    const normalizedUri = state.uri ? normalizeSpotifyAudiopath(state.uri) : null;
    if (normalizedUri && ctx.queue.items.length) {
      const idx = ctx.queue.items.findIndex(
        (item) => normalizeSpotifyAudiopath(item.audiopath) === normalizedUri,
      );
      if (idx >= 0 && idx !== ctx.queue.currentIndex) {
        ctx.queueController.setCurrentIndex(idx);
        const current = ctx.queueController.current();
        if (current) {
          const fallback = fallbackTitle(ctx.state.title, ctx.name);
          patch.title = sanitizeTitle(current.title, fallback);
          patch.artist = current.artist;
          patch.album = current.album;
          patch.coverurl = current.coverurl;
          patch.audiopath = current.audiopath;
          patch.station = current.station;
          patch.qindex = idx;
          patch.qid = current.unique_id;
          patch.type = this.audioHelpers.getStateFileType();
          const stateAudiotype = this.audioHelpers.getStateAudiotype(ctx, current);
          if (stateAudiotype != null) {
            patch.audiotype = stateAudiotype;
          }
        }
      }
    }
    if (typeof state.duration === 'number' && state.duration > 0) {
      patch.duration = Math.round(state.duration);
    }
    // Ignore output-provided position ticks; the player already drives timing,
    // and accepting external time updates can create feedback loops and noisy broadcasts.
    if (state.status === 'paused') {
      patch.mode = 'pause';
      patch.clientState = 'on';
      patch.power = 'on';
    } else if (state.status === 'playing') {
      patch.mode = 'play';
      patch.clientState = 'on';
      patch.power = 'on';
    }
    if (Object.keys(patch).length > 0) {
      this.applyPatch(zoneId, patch);
    }
  }

  public handlePlaybackError(
    zoneId: number,
    reason: string | undefined,
    source: 'player' | 'output',
    extraLog?: Record<string, unknown>,
  ): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    const normalized = typeof reason === 'string' ? reason.trim() : '';
    if (normalized && IGNORED_PLAYER_ERROR_REASONS.has(normalized)) {
      return;
    }
    const cleaned = normalized ? normalized.replace(/\s+/g, ' ') : '';
    const alias = cleaned ? PLAYBACK_ERROR_ALIASES[cleaned.toLowerCase()] : undefined;
    const detail = alias ?? cleaned;
    const title = detail ? `Playback error: ${detail}` : 'Playback error';
    this.applyPatch(zoneId, {
      title,
      artist: '',
      album: '',
      station: '',
      time: 0,
      mode: 'stop',
      clientState: 'on',
      power: 'on',
    });
    if (ctx.player.getState().mode !== 'stopped') {
      ctx.player.stop();
    }
    this.log.warn('playback error', { zoneId, reason: cleaned || undefined, source, ...extraLog });
  }

  public setupPlayerListeners(
    player: ZoneContext['player'],
    outputs: ZoneOutput[],
    zoneId: number,
    zoneName: string,
    sourceMac: string,
  ): void {
    player.on('paused', (session) => {
      const ctxLocal = this.zoneRepo.get(zoneId);
      if (ctxLocal) {
        this.dispatchOutputs(ctxLocal, outputs, 'pause', session);
      }
      this.applyPatch(zoneId, { mode: 'pause', clientState: 'on', power: 'on' });
    });
    player.on('started', (session) => {
      const ctxReset = this.zoneRepo.get(zoneId);
      if (ctxReset) {
        ctxReset.outputTimingActive = false;
        ctxReset.lastOutputTimingAt = 0;
      }
      const ctxLocal = this.zoneRepo.get(zoneId);
      if (ctxLocal) {
        this.dispatchOutputs(ctxLocal, outputs, 'play', session);
      }
      const ctx = this.zoneRepo.get(zoneId);
      if (ctx) {
        this.dispatchVolume(ctx, outputs, ctx.state.volume);
        const meta = session.metadata ?? ({} as PlaybackMetadata);
        const basePatch: Partial<LoxoneZoneState> = {
          mode: 'play',
          clientState: 'on',
          power: 'on',
          title: sanitizeTitle(meta.title, fallbackTitle(ctx.state.title, ctx.name)),
          artist: meta.artist ?? ctx.state.artist,
          album: meta.album ?? ctx.state.album,
          coverurl: meta.coverurl ?? ctx.state.coverurl,
          audiopath: meta.audiopath ?? ctx.state.audiopath,
          queueAuthority: ctx.queue.authority,
          duration:
            typeof meta.duration === 'number' && meta.duration > 0
              ? Math.max(ctx.state.duration ?? 0, Math.round(meta.duration))
              : ctx.state.duration,
        };
        this.applyPatch(zoneId, { ...basePatch, ...this.buildActiveItemPatch(ctx) });
      }
    });
    player.on('resumed', (session) => {
      const ctxReset = this.zoneRepo.get(zoneId);
      if (ctxReset) {
        ctxReset.outputTimingActive = false;
        ctxReset.lastOutputTimingAt = 0;
      }
      const ctxLocal = this.zoneRepo.get(zoneId);
      if (ctxLocal) {
        this.dispatchOutputs(ctxLocal, outputs, 'resume', session);
      }
      const ctx = this.zoneRepo.get(zoneId);
      const itemPatch = ctx ? this.buildActiveItemPatch(ctx) : {};
      this.applyPatch(zoneId, { mode: 'play', clientState: 'on', power: 'on', ...itemPatch });
    });
    player.on('stopped', (session) => {
      const ctxReset = this.zoneRepo.get(zoneId);
      if (ctxReset) {
        ctxReset.outputTimingActive = false;
        ctxReset.lastOutputTimingAt = 0;
      }
      const ctxLocal = this.zoneRepo.get(zoneId);
      if (ctxLocal) {
        this.dispatchOutputs(ctxLocal, outputs, 'stop', session);
      }
      this.applyPatch(zoneId, { mode: 'stop', clientState: 'on', power: 'on', time: 0, duration: 0 });
    });
    player.on('position', (time, duration) => {
      const ctx = this.zoneRepo.get(zoneId);
      if (!ctx) {
        return;
      }
      if (this.audioHelpers.isRadioAudiopath(ctx.state.audiopath, ctx.state.audiotype)) {
        if (ctx.state.time !== 0 || ctx.state.duration !== 0) {
          this.applyPatch(zoneId, { time: 0, duration: 0 });
        }
        return;
      }
      const now = Date.now();
      const safeDuration = Math.max(0, duration);
      const safeTime = Math.max(0, Math.min(time, safeDuration || Number.MAX_SAFE_INTEGER));
      const durationChanged =
        safeDuration > 0 &&
        (typeof ctx.state.duration !== 'number' || Math.round(ctx.state.duration) !== safeDuration);
      const withinThrottle = now - ctx.lastPositionUpdateAt < 1000 && safeTime === ctx.lastPositionValue && !durationChanged;
      if (withinThrottle) {
        return;
      }
      ctx.lastPositionUpdateAt = now;
      ctx.lastPositionValue = safeTime;
      this.applyPatch(zoneId, { time: safeTime, duration: safeDuration > 0 ? safeDuration : undefined });
      if (ctx.outputTimingActive && now - ctx.lastOutputTimingAt < 8000) {
        return;
      }
      if (ctx.outputTimingActive && now - ctx.lastOutputTimingAt >= 8000) {
        ctx.outputTimingActive = false;
      }
    });
    player.on('metadata', (metadata) => {
      const patch: Partial<LoxoneZoneState> = {};
      if (typeof metadata.title === 'string') {
        patch.title = metadata.title;
      }
      if (typeof metadata.artist === 'string') {
        patch.artist = metadata.artist;
      }
      if (typeof metadata.album === 'string') {
        patch.album = metadata.album;
      }
      if (typeof metadata.coverurl === 'string') {
        patch.coverurl = metadata.coverurl;
      }
      if (typeof metadata.duration === 'number' && metadata.duration > 0) {
        patch.duration = Math.max(patch.duration ?? 0, Math.round(metadata.duration));
      }
      if (Object.keys(patch).length > 0) {
        this.applyPatch(zoneId, patch);
      }
    });
    player.on('cover', (relative) => {
      const coverurl = relative ? `${this.buildAbsoluteCoverUrl(relative)}?t=${Date.now()}` : '';
      if (coverurl) {
        this.applyPatch(zoneId, { coverurl });
      }
    });
    player.on('volume', (level) => {
      const ctx = this.zoneRepo.get(zoneId);
      if (!ctx) {
        return;
      }
      const clamped = clampVolumeForZone(ctx.config, level);
      this.applyPatch(zoneId, { volume: clamped });
      this.dispatchVolume(ctx, outputs, clamped);
    });
    player.on('ended', () => {
      const ctx = this.zoneRepo.get(zoneId);
      if (!ctx) {
        return;
      }
      if (ctx.alert) {
        void this.stopAlert(zoneId);
        return;
      }
      void this.handleEndOfTrack(ctx);
    });
    player.on('error', (reason) => {
      this.handlePlaybackError(zoneId, reason, 'player', { zone: zoneName, sourceMac });
    });
  }

  public setInputMode(ctx: ZoneContext | undefined, mode: ZoneContext['inputMode']): void {
    if (!ctx) {
      return;
    }
    ctx.activeInput = mode;
    ctx.inputMode = mode;
  }

  private stopSpotifyOutputs(outputs: ZoneOutput[]): void {
    outputs
      .filter((t) => t.type === 'spotify')
      .forEach((t) => {
        try {
          t.stop?.(null);
        } catch {
          /* ignore */
        }
      });
  }

  private stopExternalInputSessions(
    zoneId: number,
    prevInput: ZoneContext['inputMode'],
    nextInput: ZoneContext['inputMode'],
  ): void {
    if (!prevInput || prevInput === nextInput) {
      return;
    }
    const reason = `switch_to_${nextInput ?? 'queue'}`;
    if (prevInput === 'airplay') {
      this.inputsPort.stopAirplaySession(zoneId, reason);
    }
    if (prevInput === 'spotify') {
      this.inputsPort.stopSpotifySession(zoneId, reason);
    }
    if (prevInput === 'musicassistant') {
      void this.inputsPort.switchAway(zoneId);
    }
    if (prevInput === 'linein') {
      const ctx = this.zoneRepo.get(zoneId);
      const inputId = this.audioHelpers.parseLineInInputId(ctx?.state.audiopath);
      if (inputId) {
        this.inputsPort.requestLineInStop(inputId);
      }
    }
  }

  private isLocalQueueAuthority(authority: QueueAuthority | undefined | null): boolean {
    return this.queueController.isLocalQueueAuthority(authority);
  }

  private isQueueDriven(mode: ZoneContext['inputMode']): boolean {
    return (
      !mode ||
      mode === 'queue' ||
      mode === 'spotify' ||
      mode === 'musicassistant'
    );
  }

  private buildActiveItemPatch(ctx: ZoneContext): Partial<LoxoneZoneState> {
    if (ctx.alert) {
      return {
        title: ctx.alert.title,
        artist: '',
        album: '',
        coverurl: '',
        audiopath: ctx.alert.url,
        station: '',
        qindex: ctx.alert.snapshot.queue.currentIndex,
        qid: `alert-${ctx.id}`,
        audiotype: AudioType.File,
        type: this.audioHelpers.resolveAlertEventType(ctx.alert.type),
        sourceName: ctx.name,
      };
    }
    const current = ctx.queueController.current();
    if (!current) {
      return {};
    }
    const audiotype = this.audioHelpers.getStateAudiotype(ctx, current);
    const stationForState = current.audiotype === 1 || current.audiotype === 4 ? current.station : '';
    const patch: Partial<LoxoneZoneState> = {
      title: current.title,
      artist: current.artist,
      album: current.album,
      coverurl: current.coverurl,
      audiopath: current.audiopath,
      station: stationForState,
      qindex: ctx.queueController.currentIndex(),
      qid: current.unique_id,
      duration: typeof current.duration === 'number' ? Math.max(0, Math.round(current.duration)) : 0,
      type: this.audioHelpers.getStateFileType(),
      queueAuthority: ctx.queue.authority,
    };
    if (audiotype !== null) {
      patch.audiotype = audiotype;
      const sourceName = this.audioHelpers.resolveSourceName(audiotype, ctx, current);
      if (sourceName) {
        patch.sourceName = sourceName;
      }
    }
    return patch;
  }

  private buildAbsoluteCoverUrl(pathname: string): string {
    if (!pathname) {
      return '';
    }
    if (/^https?:\/\//i.test(pathname)) {
      return pathname;
    }
    const sys = this.configPort.getSystemConfig();
    const host = sys.audioserver.ip?.trim() || '127.0.0.1';
    const port = 7090;
    const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
    return `http://${host}:${port}${normalized}`;
  }

  private isActiveInput(ctx: ZoneContext, mode: ZoneContext['inputMode']): boolean {
    return ctx.inputMode === mode && ctx.state.mode !== 'stop';
  }

  private isSameAudiopath(ctx: ZoneContext, target: string): boolean {
    if (!target) {
      return false;
    }
    const current = ctx.queueController.current()?.audiopath ?? ctx.state.audiopath ?? '';
    if (!current) {
      return false;
    }
    return normalizeSpotifyAudiopath(current) === normalizeSpotifyAudiopath(target);
  }

  private dispatchQueueStep(ctx: ZoneContext, outputs: ZoneOutput[], delta: number): boolean {
    return this.outputRouter.dispatchQueueStep(ctx, outputs, delta);
  }

  private dispatchOutputs(
    ctx: ZoneContext,
    outputs: ZoneOutput[],
    action: 'play' | 'pause' | 'resume' | 'stop',
    payload: PlaybackSession | null | undefined,
  ): void {
    this.outputRouter.dispatchOutputs(ctx, outputs, action, payload);
  }

  private dispatchVolume(
    ctx: ZoneContext,
    outputs: ZoneOutput[],
    volume: number,
  ): void {
    this.outputRouter.dispatchVolume(ctx, outputs, volume);
  }

  private selectPlayOutputs(
    outputs: ZoneOutput[],
    _session: PlaybackSession | null,
  ): ZoneOutput[] {
    return this.outputRouter.selectPlayOutputs(outputs, _session);
  }

  private stepQueue(zoneId: number, delta: number): void {
    void this.stepQueueAsync(zoneId, delta);
  }

  private async stepQueueAsync(zoneId: number, delta: number): Promise<void> {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx || ctx.queue.items.length === 0) {
      return;
    }
    if (!this.isLocalQueueAuthority(ctx.queue.authority)) {
      return;
    }

    const nextIndex = ctx.queueController.step(delta);
    if (nextIndex < 0) {
      return;
    }

    const item = ctx.queueController.current();
    if (!item) {
      return;
    }
    const session = await this.startQueuePlayback(ctx, item.audiopath, {
      title: item.title,
      artist: item.artist,
      album: item.album,
      coverurl: item.coverurl,
      audiopath: item.audiopath,
      duration: item.duration,
      station: item.station,
      isRadio: this.audioHelpers.isRadioAudiopath(item.audiopath, item.audiotype),
    });
    if (session) {
      const stateAudiotype = this.audioHelpers.getStateAudiotype(ctx, item);
      const sourceName = this.audioHelpers.resolveSourceName(stateAudiotype ?? item.audiotype ?? null, ctx, item);
      this.applyPatch(zoneId, {
        title: item.title,
        artist: item.artist,
        album: item.album,
        coverurl: item.coverurl,
        audiopath: item.audiopath,
        station: item.station,
        qindex: nextIndex,
        qid: item.unique_id,
        mode: 'play',
        clientState: 'on',
        power: 'on',
        ...(stateAudiotype != null ? { audiotype: stateAudiotype } : {}),
        type: this.audioHelpers.getStateFileType(),
        duration: typeof item.duration === 'number' ? Math.max(0, Math.round(item.duration)) : undefined,
        queueAuthority: ctx.queue.authority,
        ...(sourceName ? { sourceName } : {}),
        time: 0,
      });
    }
  }

  private async handleEndOfTrack(ctx: ZoneContext): Promise<void> {
    const queueSize = ctx.queue.items.length;
    if (queueSize === 0) {
      const stopped = ctx.player.stop('queue_empty');
      this.dispatchOutputs(ctx, ctx.outputs, 'stop', stopped);
      return;
    }

    if (!this.isLocalQueueAuthority(ctx.queue.authority)) {
      return;
    }

    const nextIndex = ctx.queueController.nextIndex();

    if (nextIndex < 0) {
      const stopped = ctx.player.stop('queue_end');
      this.dispatchOutputs(ctx, ctx.outputs, 'stop', stopped);
      return;
    }

    ctx.queueController.setCurrentIndex(nextIndex);
    const next = ctx.queueController.current();
    if (!next) {
      const stopped = ctx.player.stop('queue_invalid_next');
      this.dispatchOutputs(ctx, ctx.outputs, 'stop', stopped);
      return;
    }
    const session = await this.startQueuePlayback(ctx, next.audiopath, {
      title: next.title,
      artist: next.artist,
      album: next.album,
      coverurl: next.coverurl,
      audiopath: next.audiopath,
      duration: next.duration,
      station: next.station,
    });
    if (session) {
      const stateAudiotype = this.audioHelpers.getStateAudiotype(ctx, next);
      const sourceName = this.audioHelpers.resolveSourceName(stateAudiotype ?? next.audiotype ?? null, ctx, next);
      this.applyPatch(ctx.id, {
        title: next.title,
        artist: next.artist,
        album: next.album,
        coverurl: next.coverurl,
        audiopath: next.audiopath,
        station: next.station,
        qindex: ctx.queueController.currentIndex(),
        qid: next.unique_id,
        mode: 'play',
        clientState: 'on',
        power: 'on',
        ...(stateAudiotype != null ? { audiotype: stateAudiotype } : {}),
        type: this.audioHelpers.getStateFileType(),
        ...(sourceName ? { sourceName } : {}),
        time: 0,
      });
      void this.recentsManager.record(ctx.id, next);
      return;
    }

    // If we failed to start the next track, stop cleanly.
    const stopped = ctx.player.stop('queue_next_failed');
    this.dispatchOutputs(ctx, ctx.outputs, 'stop', stopped);
  }

  private reorderQueue(
    ctx: ZoneContext,
    mode: 'shuffle' | 'unshuffle',
    opts: { keepCurrent: boolean; shuffleUpcoming?: boolean },
  ): void {
    this.queueController.reorderQueue(ctx, mode, opts);
  }
}
