import type { ComponentLogger } from '@/shared/logging/logger';
import type {
  AudioManager,
  PlaybackMetadata,
  PlaybackSession,
} from '@/application/playback/audioManager';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import type { ZoneContext } from '@/application/zones/internal/zoneTypes';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import type { ContentPort } from '@/ports/ContentPort';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { ZoneRepository } from '@/application/zones/ZoneRepository';
import type { ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';
import { QueueController as ZoneQueueController } from '@/application/zones/QueueController';
import { decodeAudiopath, encodeAudiopath } from '@/domain/loxone/audiopath';
import {
  normalizeSpotifyAudiopath,
  sanitizeStation,
} from '@/application/zones/helpers/queueHelpers';
import { parseParentContext } from '@/application/zones/policies/ParentContextPolicy';
import { classifyIsRadio } from '@/application/zones/policies/RadioClassificationPolicy';
import { enrichMetadata } from '@/application/zones/metadata/MetadataEnricher';
import { buildQueueForRequest, type QueueBuildResult } from '@/application/zones/queue/QueueBuilder';
import { getMusicAssistantProviderId } from '@/application/zones/internal/musicAssistantProvider';
import { isActiveInputMode } from '@/application/zones/playback/guards';
import { resolveQueueAuthority } from '@/application/zones/playback/queueOps';
import { resolvePlayRequest } from '@/application/zones/playback/playRequestResolution';
import type { ResolvedPlayRequest } from '@/application/zones/playback/types';
import { isSameAudiopath } from '@/application/zones/playback/targetResolution';
import { buildQueueItemPlaybackPatch } from '@/application/zones/playback/patchBuilder';

type InputMode = ZoneContext['inputMode'];

export interface PlayRequestServiceDeps {
  zoneRepo: ZoneRepository;
  queueController: ZoneQueueController;
  audioManager: AudioManager;
  audioHelpers: ZoneAudioHelpers;
  contentPort: ContentPort;
  notifier: NotifierPort;
  recentsManager: RecentsManager;
  log: ComponentLogger;
  applyPatch: (zoneId: number, patch: Partial<LoxoneZoneState>, force?: boolean) => void;
  /** Pipeline-external playback entry point (kept on coordinator). */
  startQueuePlayback: (
    ctx: ZoneContext,
    audiopath: string,
    metadata?: PlaybackMetadata,
    options?: { skipExternalStop?: boolean; startAtSec?: number },
  ) => Promise<PlaybackSession | null>;
  /** Stops other input sessions when switching active input. */
  stopExternalInputSessions: (zoneId: number, prevInput: InputMode | null, nextInput: InputMode | null) => void;
  /** Triggers next-track prefetch after queue rebuilds. */
  prefetchNextQueueItem: (ctx: ZoneContext) => void;
  /** Dispatches an output action; only used for the unplayable-source stop fallback. */
  dispatchOutputs: (
    ctx: ZoneContext,
    outputs: ZoneOutput[],
    action: 'play' | 'pause' | 'resume' | 'stop',
    payload: PlaybackSession | null | undefined,
  ) => void;
  /**
   * Returns true (and clears the flag) when the zone was previously marked as
   * having no output configured, so the unplayable-source path can suppress its
   * warning. Implemented by coordinator over its zonesMissingOutput set.
   */
  consumeMissingOutputFlag: (zoneId: number) => boolean;
}

/**
 * Handles "play this content" requests: routing, fast-start track playback,
 * queue rebuilding, and seek-into-existing-queue. Owns the per-zone build
 * tokens that protect against superseded background rebuilds.
 */
export class PlayRequestService {
  private readonly queueBuildTokens = new Map<number, string>();

  constructor(private readonly deps: PlayRequestServiceDeps) {}

  public async play(
    zoneId: number,
    uri: string,
    type: string,
    metadata?: PlaybackMetadata,
    options?: { startAtSec?: number },
  ): Promise<void> {
    const ctx = this.deps.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    const req = resolvePlayRequest({
      uri,
      type,
      metadata,
      deps: {
        audioHelpers: this.deps.audioHelpers,
        parseParentContext,
        classifyIsRadio,
        decodeAudiopath,
        encodeAudiopath,
        normalizeSpotifyAudiopath,
        sanitizeStation,
        isAppleMusicProvider: (providerId: string) => this.deps.contentPort.isAppleMusicProvider(providerId),
        isDeezerProvider: (providerId: string) => this.deps.contentPort.isDeezerProvider(providerId),
        isTidalProvider: (providerId: string) => this.deps.contentPort.isTidalProvider(providerId),
        getMusicAssistantProviderId,
      },
    });

    if (req.isMusicAssistant && type === 'serviceplay' && isActiveInputMode(ctx, 'musicassistant')) {
      const currentAudiopath = ctx.queueController.current()?.audiopath ?? ctx.state.audiopath ?? '';
      if (isSameAudiopath(currentAudiopath, req.queueAudiopath)) {
        this.deps.log.debug('playContent ignored; musicassistant already playing target', {
          zoneId,
          target: normalizeSpotifyAudiopath(req.queueAudiopath),
        });
        return;
      }
    }

    this.deps.audioManager.markPlayRequest(zoneId, { uri, type });

    if (req.isYoutube || req.isYtMusic) {
      this.deps.notifier.notifyZoneStateChanged({
        ...ctx.state,
        mode: 'play',
        title: 'Loading…',
        artist: '',
        album: '',
        coverurl: '',
        duration: 0,
        time: 0,
        audiotype: 5,
        audiopath: req.queueAudiopath || uri,
      });
    }

    this.deps.stopExternalInputSessions(zoneId, ctx.inputMode ?? null, req.nextInput);

    if (req.isRadio && req.stationValue?.trim() && !this.deps.audioHelpers.isLikelyHostLabel(req.stationValue)) {
      ctx.metadata.radioStationFallback = req.stationValue.trim();
    }

    this.deps.log.info('playContent', {
      zoneId,
      type,
      uri,
      resolvedTarget: req.resolvedTarget,
      normalizedTarget: req.normalizedTarget,
      station: req.stationUri,
      hasParentContext: req.hasParentContext,
    });

    if (await this.trySeekExistingQueue(ctx, req, metadata, options?.startAtSec)) {
      return;
    }

    this.prefetchOnDemandSource(ctx, req, type);

    const fastStarted = await this.tryStartImmediateTrackPlayback(
      ctx,
      req,
      type,
      metadata,
      options?.startAtSec,
    );
    if (fastStarted) {
      return;
    }

    const queueBuild = await this.rebuildQueue(ctx, req, metadata);
    if (!queueBuild) {
      this.deps.log.debug('queue build skipped; request superseded', { zoneId: ctx.id, uri: req.uri });
      return;
    }
    await this.startFromCurrentQueueItem(ctx, req, queueBuild, options?.startAtSec);
  }

  private prefetchOnDemandSource(ctx: ZoneContext, req: ResolvedPlayRequest, requestType: string): void {
    if (requestType !== 'serviceplay') {
      return;
    }
    if (req.isRadio || req.isLineIn || req.isMusicAssistant) {
      return;
    }
    if (!req.isAppleMusic && !req.isDeezer && !req.isTidal && !req.isYtMusic) {
      return;
    }
    const audiopath = req.parentContext?.startItem ?? req.queueAudiopath;
    if (!audiopath || !this.isTrackAudiopath(audiopath)) {
      return;
    }
    void this.deps.contentPort.resolvePlaybackSource({
      zoneId: ctx.id,
      zoneName: ctx.name,
      audiopath,
      prefetch: true,
    }).catch((error) => {
      this.deps.log.debug('playback source prefetch failed', {
        zoneId: ctx.id,
        audiopath,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private isTrackAudiopath(audiopath: string): boolean {
    return /:track:|:library-track:/i.test(audiopath);
  }

  private async trySeekExistingQueue(
    ctx: ZoneContext,
    req: ResolvedPlayRequest,
    _metadata?: PlaybackMetadata,
    startAtSec?: number,
  ): Promise<boolean> {
    if (req.hasParentContext || ctx.state.mode === 'stop') {
      return false;
    }
    const seekCandidates = [req.normalizedTarget, req.queueAudiopath, req.uri].filter(
      (c): c is string => Boolean(c),
    );
    let seeked = false;
    for (const candidate of seekCandidates) {
      if (this.deps.queueController.seekExistingQueueInternal(ctx, candidate)) {
        seeked = true;
        break;
      }
    }
    if (!seeked) {
      return false;
    }
    const current = ctx.queueController.current();
    if (!current) {
      this.deps.log.warn('queue seek failed; no current item', { zoneId: ctx.id, target: req.normalizedTarget });
      this.deps.audioManager.clearPlayRequest(ctx.id);
      return true;
    }
    const session = await this.deps.startQueuePlayback(
      ctx,
      current.audiopath,
      {
        title: current.title || ctx.name,
        artist: current.artist || '',
        album: current.album || '',
        coverurl: current.coverurl,
        duration: current.duration,
        audiopath: current.audiopath,
        station: current.station,
        stationIndex: ctx.queueController.currentIndex(),
        isRadio: this.deps.audioHelpers.isRadioAudiopath(current.audiopath, current.audiotype),
      },
      { skipExternalStop: true, startAtSec },
    );
    if (session) {
      void this.deps.recentsManager.record(ctx.id, current);
      if (!this.deps.audioHelpers.isRadioAudiopath(current.audiopath, current.audiotype)) {
        this.deps.notifier.notifyQueueUpdated(ctx.id, ctx.queue.items.length);
      }
    } else {
      this.deps.audioManager.clearPlayRequest(ctx.id);
      this.handleUnplayableSource(ctx, current.audiopath);
    }
    return true;
  }

  private async rebuildQueue(
    ctx: ZoneContext,
    req: ResolvedPlayRequest,
    metadata?: PlaybackMetadata,
    options?: { applyToken?: string },
  ): Promise<QueueBuildResult | null> {
    const queueBuild = await buildQueueForRequest({
      request: {
        zoneId: ctx.id,
        zoneName: ctx.name,
        uri: req.uri,
        resolvedTarget: req.resolvedTarget,
        stationUri: req.stationUri || undefined,
        stationValue: req.stationValue,
        queueSourcePath: req.queueSourcePath,
        queueAudiopath: req.queueAudiopath,
        parentContext: req.parentContext,
        isRadio: req.isRadio,
        isAppleMusic: req.isAppleMusic,
        isDeezer: req.isDeezer,
        isTidal: req.isTidal,
        isYtMusic: req.isYtMusic,
        isMusicAssistant: req.isMusicAssistant,
        isLineIn: req.isLineIn,
        queueBuildLimit: req.queueBuildLimit,
        startIndexHint: req.parentContext?.startIndex,
        startItemHint: req.parentContext?.startItem,
      },
      queueController: this.deps.queueController,
      content: this.deps.contentPort,
      audioHelpers: this.deps.audioHelpers,
      resolveMetadata: () => enrichMetadata({
        content: this.deps.contentPort,
        uri: req.uri,
        queueAudiopath: req.queueAudiopath,
        parentContext: req.parentContext,
        isRadio: req.isRadio,
        isMusicAssistant: req.isMusicAssistant,
        isAppleMusic: req.isAppleMusic,
        stationValue: req.stationValue,
        incoming: metadata,
      }),
    });
    if (options?.applyToken && this.queueBuildTokens.get(ctx.id) !== options.applyToken) {
      return null;
    }
    this.deps.log.debug('queue build resolved', {
      zoneId: ctx.id,
      queueSourcePath: req.queueSourcePath,
      resolvedTarget: req.resolvedTarget,
      expandedCount: queueBuild.expandedCount,
      isAppleMusic: req.isAppleMusic,
      isMusicAssistant: req.isMusicAssistant,
    });
    const queueItems = queueBuild.items;
    const clampedIndex = queueBuild.startIndex;
    this.setQueueAuthorityForRequest(ctx, req);
    this.deps.log.debug('queue rebuilt', {
      zoneId: ctx.id,
      items: queueItems.length,
      startIndex: clampedIndex,
      target: queueItems[clampedIndex]?.audiopath,
      authority: ctx.queue.authority,
    });
    ctx.queueController.setItems(queueItems, clampedIndex);
    ctx.metadata.queueShuffled = false;
    const immediateCurrent = ctx.queueController.current();
    if (immediateCurrent && !req.isYoutube && !req.isYtMusic) {
      const immediatePatch = buildQueueItemPlaybackPatch(
        ctx,
        immediateCurrent,
        ctx.queueController.currentIndex(),
        this.deps.audioHelpers,
      );
      if (Object.keys(immediatePatch).length > 0) {
        this.deps.applyPatch(ctx.id, immediatePatch);
      }
    }
    const pendingShuffle = ctx.metadata.pendingShuffle;
    if (typeof pendingShuffle === 'boolean') {
      ctx.queue.shuffle = pendingShuffle;
      delete ctx.metadata.pendingShuffle;
      this.deps.applyPatch(ctx.id, { plshuffle: pendingShuffle ? 1 : 0 });
    } else {
      ctx.queue.shuffle = false;
    }
    ctx.queue.repeat = 0;
    if (ctx.queue.shuffle) {
      const preserveCurrent = typeof pendingShuffle !== 'boolean';
      this.deps.queueController.reorderQueue(ctx, 'shuffle', {
        keepCurrent: preserveCurrent,
        shuffleUpcoming: preserveCurrent,
      });
      if (!preserveCurrent) {
        ctx.queueController.setCurrentIndex(0);
        this.deps.applyPatch(ctx.id, { qindex: 0 });
      }
      this.deps.prefetchNextQueueItem(ctx);
    }
    this.deps.prefetchNextQueueItem(ctx);
    if (queueBuild.shouldFillInBackground && queueBuild.fillArgs) {
      const token = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
      ctx.metadata.queueFillToken = token;
      void this.deps.queueController.fillQueueInBackground(
        ctx,
        queueBuild.fillArgs.resolvedTarget,
        ctx.name,
        queueBuild.fillArgs.stationUri || undefined,
        queueBuild.fillArgs.queueSourcePath,
        token,
      );
    }
    return queueBuild;
  }

  private async tryStartImmediateTrackPlayback(
    ctx: ZoneContext,
    req: ResolvedPlayRequest,
    requestType: string,
    metadata?: PlaybackMetadata,
    startAtSec?: number,
  ): Promise<boolean> {
    if (requestType === 'linein' || req.isRadio) {
      return false;
    }
    // MA-sink: MA owns the queue, so we don't need to expand the parent
    // container locally before firing play_media. Fire immediately and let
    // the MA state-mirror populate the local queue afterwards. The paginated
    // getServiceFolder loop in QueueController is what makes container picks
    // take 4-5 s before audio starts in sink mode.
    const hasMaOutput = ctx.outputs.some((output) => output.type === 'musicassistant');
    const maSinkFastPath = req.isMusicAssistant && hasMaOutput;
    if (!maSinkFastPath && !req.isAppleMusic && !req.isDeezer && !req.isTidal && !req.isYtMusic) {
      return false;
    }
    if (requestType !== 'serviceplay') {
      return false;
    }
    const audiopath = req.parentContext?.startItem ?? req.queueAudiopath;
    if (!audiopath || !this.isTrackAudiopath(audiopath)) {
      return false;
    }
    this.setQueueAuthorityForRequest(ctx, req);
    const session = await this.deps.startQueuePlayback(
      ctx,
      audiopath,
      {
        title: metadata?.title?.trim() || ctx.name,
        artist: metadata?.artist?.trim() || '',
        album: metadata?.album?.trim() || '',
        coverurl: metadata?.coverurl,
        duration: metadata?.duration,
        audiopath: metadata?.audiopath ?? audiopath,
        trackId: metadata?.trackId,
        station: req.stationValue,
        isRadio: false,
      },
      { skipExternalStop: true, startAtSec },
    );
    if (!session) {
      return false;
    }
    // MA-sink owns its queue server-side and mirrors it back via the
    // MusicAssistantStateController. Skip the local rebuildQueue: it would
    // paginate MA's getServiceFolder for no benefit (wasted RPC) and the
    // resulting buildQueueItemPlaybackPatch would overwrite MA's authoritative
    // title/artist/album with whatever our local queue snapshot resolved to.
    if (maSinkFastPath) {
      return true;
    }
    const token = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    this.queueBuildTokens.set(ctx.id, token);
    void this.rebuildQueue(ctx, req, metadata, { applyToken: token })
      .then((queueBuild) => {
        if (!queueBuild) {
          return;
        }
        if (this.queueBuildTokens.get(ctx.id) === token) {
          this.queueBuildTokens.delete(ctx.id);
        }
        const current = ctx.queueController.current();
        const currentAudiopath = current?.audiopath ?? ctx.state.audiopath ?? '';
        if (current && isSameAudiopath(currentAudiopath, audiopath)) {
          void this.deps.recentsManager.record(ctx.id, current);
          this.deps.notifier.notifyQueueUpdated(ctx.id, ctx.queue.items.length);
        }
        // MA-sink: MA's state-mirror is authoritative for title/artist/album.
        // The background rebuildQueue completes ~4 s after MA has already pushed
        // real metadata, so pushing a derived patch here would overwrite the
        // correct MA values with whatever our local queue mirror resolved to.
        if (current && isSameAudiopath(currentAudiopath, audiopath) && !maSinkFastPath) {
          const baseMeta = queueBuild.metadata ?? ({} as PlaybackMetadata);
          const resolvedMeta = {
            title: baseMeta.title?.trim() || current.title,
            artist: baseMeta.artist?.trim() || current.artist,
            album: baseMeta.album?.trim() || current.album,
            coverurl: baseMeta.coverurl || current.coverurl,
            duration:
              typeof baseMeta.duration === 'number' && baseMeta.duration > 0
                ? baseMeta.duration
                : current.duration,
            audiopath: baseMeta.audiopath ?? current.audiopath ?? audiopath,
            station: baseMeta.station ?? current.station,
            trackId: baseMeta.trackId,
            stationIndex: baseMeta.stationIndex,
            queue: baseMeta.queue,
            queueIndex: baseMeta.queueIndex,
          };
          ctx.player.updateMetadata(resolvedMeta);
        }
      })
      .catch((error) => {
        this.deps.log.debug('queue build after fast start failed', {
          zoneId: ctx.id,
          audiopath,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  private setQueueAuthorityForRequest(ctx: ZoneContext, req: ResolvedPlayRequest): void {
    const bridgeProvider =
      this.deps.audioHelpers.resolveBridgeProvider(req.queueAudiopath) ??
      this.deps.audioHelpers.resolveBridgeProvider(req.resolvedTarget) ??
      this.deps.audioHelpers.resolveBridgeProvider(req.uri);
    ctx.queue.authority = resolveQueueAuthority({
      isMusicAssistant: req.isMusicAssistant,
      isAppleMusic: req.isAppleMusic,
      isDeezer: req.isDeezer,
      isTidal: req.isTidal,
      isSpotify: req.isSpotify,
      bridgeProvider,
    });
    if (req.isSpotify && ctx.config.inputs?.spotify?.offload !== true) {
      ctx.queue.authority = 'local';
    }
  }

  private async startFromCurrentQueueItem(
    ctx: ZoneContext,
    req: ResolvedPlayRequest,
    buildResult: QueueBuildResult,
    startAtSec?: number,
  ): Promise<void> {
    const current = ctx.queueController.current();
    if (!current) {
      this.deps.log.warn('playback skipped; empty queue after build', { zoneId: ctx.id, uri: req.uri });
      this.deps.audioManager.clearPlayRequest(ctx.id);
      return;
    }

    const stationForPlayback =
      req.isMusicAssistant && current.station ? current.station : req.stationValue;
    const enrichedMetadata = buildResult.metadata;
    const session = await this.deps.startQueuePlayback(
      ctx,
      current.audiopath,
      {
        title: enrichedMetadata?.title?.trim() || current.title || ctx.name,
        artist: enrichedMetadata?.artist?.trim() || current.artist || '',
        album: enrichedMetadata?.album?.trim() || current.album || '',
        coverurl: enrichedMetadata?.coverurl || current.coverurl,
        duration: typeof enrichedMetadata?.duration === 'number' ? enrichedMetadata.duration : current.duration,
        audiopath: enrichedMetadata?.audiopath,
        trackId: enrichedMetadata?.trackId,
        station: stationForPlayback,
        stationIndex: ctx.queueController.currentIndex(),
        isRadio: req.isRadio,
      },
      { skipExternalStop: true, startAtSec },
    );
    if (session) {
      void this.deps.recentsManager.record(ctx.id, current);
      if (!req.isRadio) {
        this.deps.notifier.notifyQueueUpdated(ctx.id, ctx.queue.items.length);
      }
    } else {
      this.deps.audioManager.clearPlayRequest(ctx.id);
      this.handleUnplayableSource(ctx, current.audiopath);
    }
  }

  private handleUnplayableSource(ctx: ZoneContext, itemAudiopath: string): void {
    if (this.deps.consumeMissingOutputFlag(ctx.id)) {
      return;
    }
    this.deps.log.warn('playback skipped; no playable source resolved', {
      zoneId: ctx.id,
      audiopath: itemAudiopath,
    });
    const shouldStayOnline =
      this.deps.audioHelpers.isMusicAssistantAudiopath(itemAudiopath) ||
      this.deps.audioHelpers.isSpotifyAudiopath(itemAudiopath) ||
      this.deps.audioHelpers.isAppleMusicAudiopath(itemAudiopath);
    this.deps.applyPatch(
      ctx.id,
      shouldStayOnline
        ? { mode: 'stop', clientState: 'on', power: 'on' }
        : { mode: 'stop', clientState: 'on', power: 'on' },
    );
    this.deps.dispatchOutputs(ctx, ctx.outputs, 'stop', null);
  }
}
