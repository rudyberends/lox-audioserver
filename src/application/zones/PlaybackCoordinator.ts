import type { ComponentLogger } from '@/shared/logging/logger';
import type { AudioManager, PlaybackMetadata, PlaybackSession, PlaybackSource, CoverArtPayload } from '@/application/playback/audioManager';
import type { ZoneAudioPreferences } from '@/application/playback/ZoneAudioPreferences';
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
import { audioOutputSettings } from '@/ports/types/audioFormat';
import { computePreferredPlaybackSettings } from '@/application/playback/policies/OutputFormatPolicy';
import { buildPlaybackPlan } from '@/application/playback/buildPlaybackPlan';
import { executePlaybackPlan } from '@/application/playback/executePlaybackPlan';
import type { ProviderKind } from '@/application/playback/types/PlaybackPlan';
import { parseParentContext } from '@/application/zones/policies/ParentContextPolicy';
import { classifyIsRadio } from '@/application/zones/policies/RadioClassificationPolicy';
import { enrichMetadata } from '@/application/zones/metadata/MetadataEnricher';
import { buildQueueForRequest, type QueueBuildResult } from '@/application/zones/queue/QueueBuilder';
import { OutputRouter } from '@/application/zones/OutputRouter';
import { QueueController as ZoneQueueController } from '@/application/zones/QueueController';
import { type ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';
import {
  getMusicAssistantProviderId,
  setMusicAssistantProviderId,
  MUSIC_ASSISTANT_PROVIDER_DEFAULT,
} from '@/application/zones/internal/musicAssistantProvider';
import { ZoneRepository } from '@/application/zones/ZoneRepository';
import type { ConfigPort } from '@/ports/ConfigPort';
import { isActiveInputMode } from '@/application/zones/playback/guards';
import { resolveQueueAuthority } from '@/application/zones/playback/queueOps';
import { resolvePlayRequest } from '@/application/zones/playback/playRequestResolution';
import type { ResolvedPlayRequest } from '@/application/zones/playback/types';
import { isSameAudiopath } from '@/application/zones/playback/targetResolution';
import { attachPlayerListeners } from '@/application/zones/playback/playerListeners';
import { buildQueueItemPlaybackPatch } from '@/application/zones/playback/patchBuilder';
import { handleZoneCommand } from '@/application/zones/playback/commandHandlers';
import { handleEndOfTrack as handleEndOfTrackTransition } from '@/application/zones/playback/queueTransitions';
import { QueueStepDispatcher } from '@/application/zones/playback/QueueStepDispatcher';
import {
  pauseInputSource as handlePauseInputSource,
  playInputSource as handlePlayInputSource,
  resumeInputSource as handleResumeInputSource,
  stopInputSource as handleStopInputSource,
  updateInputCover as handleUpdateInputCover,
  updateInputMetadata as handleUpdateInputMetadata,
  updateInputTiming as handleUpdateInputTiming,
  updateInputVolume as handleUpdateInputVolume,
  updateRadioMetadata as handleUpdateRadioMetadata,
} from '@/application/zones/playback/inputHandlers';
import { handlePlaybackError as handlePlaybackErrorTransition } from '@/application/zones/playback/playbackErrors';
import { updateOutputState as handleUpdateOutputState } from '@/application/zones/playback/outputStateUpdater';
import { RadioParadiseBlockService } from '@/application/zones/radioparadise/radioParadiseBlockService';
import { resolvePlaybackSource } from '@/application/playback/sourceResolver';

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
  zoneAudioPrefs: ZoneAudioPreferences;
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
  private readonly zoneAudioPrefs: ZoneAudioPreferences;
  private readonly radioParadise: RadioParadiseBlockService;
  private readonly queueStepDispatcher: QueueStepDispatcher;
  private readonly zonesMissingOutput = new Set<number>();
  private readonly queueBuildTokens = new Map<number, string>();
  private readonly crossfadeState = new Map<
    number,
    {
      resolving: boolean;
      resolvedSource: PlaybackSource | null;
      resolvedMetadata: PlaybackMetadata | null;
      nextAudiopath: string;
      nextQueueIndex: number;
      triggered: boolean;
      triggeredAt: number;
      /** True when the fade-in source is a Spotify stream (started at trigger time via inputsPort). */
      isSpotifyFadeIn?: boolean;
    }
  >();
  private readonly CROSSFADE_PRE_RESOLVE_EXTRA_SEC = 10;
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
    this.zoneAudioPrefs = deps.zoneAudioPrefs;
    this.radioParadise = new RadioParadiseBlockService({
      getZone: (zoneId) => this.zoneRepo.get(zoneId),
      updateRadioMetadata: (zoneId, metadata) => this.updateRadioMetadata(zoneId, metadata),
    });
    this.queueStepDispatcher = new QueueStepDispatcher({
      zoneRepo: this.zoneRepo,
      audioManager: this.audioManager,
      audioHelpers: this.audioHelpers,
      recentsManager: this.recentsManager,
      log: this.log,
      applyPatch: this.applyPatch,
      dispatchOutputs: this.dispatchOutputs.bind(this),
      isLocalQueueAuthority: this.isLocalQueueAuthority.bind(this),
      startQueuePlayback: this.startQueuePlayback.bind(this),
      prefetchPlaybackSource: this.prefetchPlaybackSource.bind(this),
      advanceTrack: this.advanceTrack.bind(this),
    });
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

  private buildInputCoordinator() {
    return {
      getZone: (id: number) => this.zoneRepo.get(id),
      log: this.log,
      audioHelpers: this.audioHelpers,
      applyPatch: this.applyPatch,
      setInputMode: this.setInputMode.bind(this),
      stopExternalInputSessions: this.stopExternalInputSessions.bind(this),
      stopSpotifyOutputs: this.stopSpotifyOutputs.bind(this),
      requestLineInStop: (inputId: string) => this.inputsPort.requestLineInStop(inputId),
      seekExistingQueueInternal: this.queueController.seekExistingQueueInternal.bind(this.queueController),
      recentsRecord: this.recentsManager.record.bind(this.recentsManager),
      buildAbsoluteCoverUrl: this.buildAbsoluteCoverUrl.bind(this),
      updateInputMetadata: this.updateInputMetadata.bind(this),
    };
  }

  public playInputSource(
    zoneId: number,
    label: string,
    playbackSource: PlaybackSource,
    metadata?: PlaybackMetadata,
  ): void {
    handlePlayInputSource({
      coordinator: this.buildInputCoordinator(),
      zoneId,
      label,
      playbackSource,
      metadata,
    });
  }

  public stopInputSource(zoneId: number): void {
    handleStopInputSource({ coordinator: this.buildInputCoordinator(), zoneId });
  }

  public pauseInputSource(zoneId: number): void {
    handlePauseInputSource({ coordinator: this.buildInputCoordinator(), zoneId });
  }

  public resumeInputSource(zoneId: number): void {
    handleResumeInputSource({ coordinator: this.buildInputCoordinator(), zoneId });
  }

  public updateInputMetadata(zoneId: number, metadata: Partial<PlaybackMetadata>): void {
    handleUpdateInputMetadata({
      coordinator: this.buildInputCoordinator(),
      zoneId,
      metadata,
    });
  }

  public updateRadioMetadata(
    zoneId: number,
    metadata: { title: string; artist: string; coverurl?: string; duration?: number; controllable?: boolean },
  ): void {
    handleUpdateRadioMetadata({
      coordinator: this.buildInputCoordinator(),
      zoneId,
      metadata,
    });

    // Keep audio session metadata in sync so HTTP clients (e.g. Squeezelite)
    // can receive dynamic "now playing" updates via ICY metadata blocks.
    const session = this.audioManager.getSession(zoneId);
    if (!session) {
      return;
    }
    const prev = session.metadata;
    const next: PlaybackMetadata = {
      title: metadata.title?.trim() || prev?.title || '',
      artist: metadata.artist?.trim() || '',
      album: prev?.album || '',
      coverurl: metadata.coverurl || prev?.coverurl,
      duration: typeof metadata.duration === 'number' ? metadata.duration : prev?.duration,
      isRadio: prev?.isRadio ?? true,
      audiopath: prev?.audiopath,
      trackId: prev?.trackId,
      station: prev?.station,
      stationIndex: prev?.stationIndex,
      queue: prev?.queue,
      queueIndex: prev?.queueIndex,
    };
    // Avoid overwriting sessions with empty mandatory fields.
    if (!next.title) {
      return;
    }
    this.audioManager.updateSessionMetadata(zoneId, next);
  }

  public updateInputCover(zoneId: number, cover?: CoverArtPayload): string | undefined {
    return handleUpdateInputCover({
      coordinator: this.buildInputCoordinator(),
      zoneId,
      cover,
    });
  }

  public updateInputVolume(zoneId: number, volume: number): void {
    handleUpdateInputVolume({
      coordinator: this.buildInputCoordinator(),
      zoneId,
      volume,
    });
  }

  public updateInputTiming(zoneId: number, elapsed: number, duration: number): void {
    handleUpdateInputTiming({
      coordinator: this.buildInputCoordinator(),
      zoneId,
      elapsed,
      duration,
    });
  }

  public async playContent(
    zoneId: number,
    uri: string,
    type: string,
    metadata?: PlaybackMetadata,
    options?: { startAtSec?: number },
  ): Promise<void> {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    const req = resolvePlayRequest({
      uri,
      type,
      metadata,
      deps: {
        audioHelpers: this.audioHelpers,
        parseParentContext,
        classifyIsRadio,
        decodeAudiopath,
        encodeAudiopath,
        normalizeSpotifyAudiopath,
        sanitizeStation,
        isAppleMusicProvider: (providerId: string) => this.contentPort.isAppleMusicProvider(providerId),
        isDeezerProvider: (providerId: string) => this.contentPort.isDeezerProvider(providerId),
        isTidalProvider: (providerId: string) => this.contentPort.isTidalProvider(providerId),
        getMusicAssistantProviderId,
      },
    });

    if (req.isMusicAssistant && type === 'serviceplay' && isActiveInputMode(ctx, 'musicassistant')) {
      const currentAudiopath = ctx.queueController.current()?.audiopath ?? ctx.state.audiopath ?? '';
      if (isSameAudiopath(currentAudiopath, req.queueAudiopath)) {
        this.log.debug('playContent ignored; musicassistant already playing target', {
          zoneId,
          target: normalizeSpotifyAudiopath(req.queueAudiopath),
        });
        return;
      }
    }

    this.audioManager.markPlayRequest(zoneId, { uri, type });

    this.stopExternalInputSessions(zoneId, ctx.inputMode ?? null, req.nextInput);

    if (req.isRadio && req.stationValue?.trim() && !this.audioHelpers.isLikelyHostLabel(req.stationValue)) {
      ctx.metadata.radioStationFallback = req.stationValue.trim();
    }

    this.log.info('playContent', {
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
      this.log.debug('queue build skipped; request superseded', { zoneId: ctx.id, uri: req.uri });
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
    void this.contentPort.resolvePlaybackSource({
      zoneId: ctx.id,
      zoneName: ctx.name,
      audiopath,
      prefetch: true,
    }).catch((error) => {
      this.log.debug('playback source prefetch failed', {
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
    if (!this.queueController.seekExistingQueueInternal(ctx, req.normalizedTarget)) {
      return false;
    }
    const current = ctx.queueController.current();
    if (!current) {
      this.log.warn('queue seek failed; no current item', { zoneId: ctx.id, target: req.normalizedTarget });
      this.audioManager.clearPlayRequest(ctx.id);
      return true;
    }
    const session = await this.startQueuePlayback(
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
        isRadio: this.audioHelpers.isRadioAudiopath(current.audiopath, current.audiotype),
      },
      { skipExternalStop: true, startAtSec },
    );
    if (session) {
      void this.recentsManager.record(ctx.id, current);
      if (!this.audioHelpers.isRadioAudiopath(current.audiopath, current.audiotype)) {
        this.notifier.notifyQueueUpdated(ctx.id, ctx.queue.items.length);
      }
    } else {
      this.audioManager.clearPlayRequest(ctx.id);
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
      queueController: this.queueController,
      content: this.contentPort,
      audioHelpers: this.audioHelpers,
      resolveMetadata: () => enrichMetadata({
        content: this.contentPort,
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
    this.log.debug('queue build resolved', {
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
    this.log.debug('queue rebuilt', {
      zoneId: ctx.id,
      items: queueItems.length,
      startIndex: clampedIndex,
      target: queueItems[clampedIndex]?.audiopath,
      authority: ctx.queue.authority,
    });
    ctx.queueController.setItems(queueItems, clampedIndex);
    ctx.metadata.queueShuffled = false;
    const immediateCurrent = ctx.queueController.current();
    if (immediateCurrent) {
      const immediatePatch = buildQueueItemPlaybackPatch(
        ctx,
        immediateCurrent,
        ctx.queueController.currentIndex(),
        this.audioHelpers,
      );
      if (Object.keys(immediatePatch).length > 0) {
        this.applyPatch(ctx.id, immediatePatch);
      }
    }
    const pendingShuffle = ctx.metadata.pendingShuffle;
    if (typeof pendingShuffle === 'boolean') {
      ctx.queue.shuffle = pendingShuffle;
      delete ctx.metadata.pendingShuffle;
      this.applyPatch(ctx.id, { plshuffle: pendingShuffle ? 1 : 0 });
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
        this.applyPatch(ctx.id, { qindex: 0 });
      }
      this.prefetchNextQueueItem(ctx);
    }
    this.prefetchNextQueueItem(ctx);
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
    return queueBuild;
  }

  private async tryStartImmediateTrackPlayback(
    ctx: ZoneContext,
    req: ResolvedPlayRequest,
    requestType: string,
    metadata?: PlaybackMetadata,
    startAtSec?: number,
  ): Promise<boolean> {
    if (requestType === 'linein' || req.isRadio || req.isMusicAssistant) {
      return false;
    }
    if (!req.isAppleMusic && !req.isDeezer && !req.isTidal && !req.isYtMusic) {
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
    const session = await this.startQueuePlayback(
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
          void this.recentsManager.record(ctx.id, current);
          this.notifier.notifyQueueUpdated(ctx.id, ctx.queue.items.length);
        }
        if (current && isSameAudiopath(currentAudiopath, audiopath)) {
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
        this.log.debug('queue build after fast start failed', {
          zoneId: ctx.id,
          audiopath,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  private setQueueAuthorityForRequest(ctx: ZoneContext, req: ResolvedPlayRequest): void {
    const bridgeProvider =
      this.audioHelpers.resolveBridgeProvider(req.queueAudiopath) ??
      this.audioHelpers.resolveBridgeProvider(req.resolvedTarget) ??
      this.audioHelpers.resolveBridgeProvider(req.uri);
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
      this.log.warn('playback skipped; empty queue after build', { zoneId: ctx.id, uri: req.uri });
      this.audioManager.clearPlayRequest(ctx.id);
      return;
    }

    const stationForPlayback =
      req.isMusicAssistant && current.station ? current.station : req.stationValue;
    const enrichedMetadata = buildResult.metadata;
    const session = await this.startQueuePlayback(
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
      void this.recentsManager.record(ctx.id, current);
      if (!req.isRadio) {
        this.notifier.notifyQueueUpdated(ctx.id, ctx.queue.items.length);
      }
    } else {
      this.audioManager.clearPlayRequest(ctx.id);
      this.handleUnplayableSource(ctx, current.audiopath);
    }
  }

  private handleUnplayableSource(ctx: ZoneContext, itemAudiopath: string): void {
    if (this.zonesMissingOutput.has(ctx.id)) {
      this.zonesMissingOutput.delete(ctx.id);
      return;
    }
    this.log.warn('playback skipped; no playable source resolved', {
      zoneId: ctx.id,
      audiopath: itemAudiopath,
    });
    const shouldStayOnline =
      this.audioHelpers.isMusicAssistantAudiopath(itemAudiopath) ||
      this.audioHelpers.isSpotifyAudiopath(itemAudiopath) ||
      this.audioHelpers.isAppleMusicAudiopath(itemAudiopath);
    this.applyPatch(
      ctx.id,
      shouldStayOnline
        ? { mode: 'stop', clientState: 'on', power: 'on' }
        : { mode: 'stop', clientState: 'on', power: 'on' },
    );
    this.dispatchOutputs(ctx, ctx.outputs, 'stop', null);
  }

  public async startQueuePlayback(
    ctx: ZoneContext,
    audiopath: string,
    metadata?: PlaybackMetadata,
    options?: { skipExternalStop?: boolean; startAtSec?: number },
  ): Promise<PlaybackSession | null> {
    this.crossfadeState.delete(ctx.id);
    const hasRadioParadise =
      this.radioParadise.isRadioParadiseAudiopath(audiopath) ||
      this.radioParadise.isRadioParadiseAudiopath(metadata?.audiopath ?? '') ||
      this.radioParadise.isRadioParadiseAudiopath(ctx.state.audiopath ?? '');
    if (!hasRadioParadise) {
      this.radioParadise.stop(ctx.id);
    }
    let resolvedAudiopath = audiopath;
    let resolvedMetadata = metadata;
    let startAtSec = options?.startAtSec;
    if (this.radioParadise.isRadioParadiseAudiopath(audiopath)) {
      const stationId = this.radioParadise.parseStationId(audiopath);
      if (!stationId) {
        this.log.warn('radio paradise station id missing', { zoneId: ctx.id, audiopath });
        return null;
      }
      const resolved = await this.radioParadise.resolveStart(ctx.id, stationId);
      if (!resolved) {
        this.log.warn('radio paradise block resolve failed', { zoneId: ctx.id, stationId });
        return null;
      }
      resolvedAudiopath = resolved.url;
      startAtSec = resolved.startAtSec;
      const base = resolvedMetadata ?? { title: '', artist: '', album: '' };
      resolvedMetadata = {
        ...base,
        isRadio: resolved.isRadio,
        title: resolved.track?.title ?? base.title ?? '',
        artist: resolved.track?.artist ?? base.artist ?? '',
        album: resolved.track?.album ?? base.album ?? '',
        coverurl: resolved.track?.coverurl ?? base.coverurl ?? '',
        duration: resolved.track?.durationSec ?? base.duration,
        station: base.station ?? resolved.stationLabel,
        audiopath,
      };
    }
    const radioContextAudiopath = resolvedMetadata?.audiopath ?? audiopath;
    const isRadioAudiopath = this.audioHelpers.isRadioAudiopath(radioContextAudiopath);
    if (isRadioAudiopath) {
      ctx.metadata.radioControllable = this.radioParadise.isRadioParadiseAudiopath(radioContextAudiopath)
        ? true
        : resolvedMetadata?.isRadio === false;
    } else if (ctx.metadata.radioControllable) {
      ctx.metadata.radioControllable = false;
    }
    const classification = this.classifyAudiopath(audiopath);
    if (!this.hasPlaybackOutput(ctx, classification)) {
      this.zonesMissingOutput.add(ctx.id);
      this.handlePlaybackError(ctx.id, 'No output configured', 'output');
      this.log.warn('playback blocked; no output configured', {
        zoneId: ctx.id,
        audiopath,
      });
      this.audioManager.clearPlayRequest(ctx.id);
      return null;
    }
    this.zonesMissingOutput.delete(ctx.id);
    // Apply preferred output from the primary target output so we can resample/format accordingly.
    const outputTargets =
      ctx.activeOutput !== null
        ? ctx.outputs.filter((output) => output.type === ctx.activeOutput)
        : this.selectPlayOutputs(ctx.outputs, null);
    const latencyMs = this.computeOutputLatencyMs(outputTargets);
    ctx.player.setEndGuardMs(latencyMs);
    const isRadio = this.audioHelpers.isRadioAudiopath(audiopath);
    const settings = computePreferredPlaybackSettings({
      zoneId: ctx.id,
      zoneName: ctx.name,
      audiopath: resolvedAudiopath,
      isRadio,
      queueAuthority: ctx.queue.authority,
      outputs: ctx.outputs,
      activeOutputType: ctx.activeOutput,
      defaults: audioOutputSettings,
    });
    this.applyPlaybackInputTransition(ctx, classification.nextInput, {
      skipExternalStop: options?.skipExternalStop,
    });
    const enrichedMetadata = this.buildEnrichedPlaybackMetadata(audiopath, resolvedMetadata);
    const provider: ProviderKind = classification.provider;
    const plan = buildPlaybackPlan({
      ctx,
      audiopath: resolvedAudiopath,
      metadata: enrichedMetadata,
      isRadio,
      preferredSettings: settings,
      classification: {
        isSpotify: classification.isSpotify,
        isMusicAssistant: classification.isMusicAssistant,
        provider,
      },
    });
    const session = await executePlaybackPlan({
      ctx,
      plan,
      content: this.contentPort,
      inputs: this.inputsPort,
      log: this.log,
      zoneAudioPrefs: this.zoneAudioPrefs,
      startAtSec,
    });
    if (!session) {
      this.audioManager.clearPlayRequest(ctx.id);
      const lastError = ctx.lastPlaybackErrorReason?.trim().toLowerCase();
      const hasRecentWidevineMissing =
        this.hasRecentPlaybackError(ctx) && lastError === 'widevine missing';
      if (plan.playExternalLabel === 'musicassistant') {
        this.handlePlaybackError(ctx.id, 'music assistant stream unavailable', 'output');
        this.log.warn('music assistant stream not ready; skipping playback', {
          zoneId: ctx.id,
        });
      } else if (plan.provider === 'applemusic') {
        if (!hasRecentWidevineMissing) {
          this.handlePlaybackError(ctx.id, 'apple music stream unavailable', 'output');
        }
        this.log.warn('apple music stream not ready; skipping playback', { zoneId: ctx.id });
      } else if (plan.provider === 'deezer') {
        this.handlePlaybackError(ctx.id, 'deezer stream unavailable', 'output');
        this.log.warn('deezer stream not ready; skipping playback', { zoneId: ctx.id });
      } else if (plan.provider === 'tidal') {
        this.handlePlaybackError(ctx.id, 'tidal stream unavailable', 'output');
        this.log.warn('tidal stream not ready; skipping playback', { zoneId: ctx.id });
      } else if (plan.provider === 'ytmusic') {
        this.handlePlaybackError(ctx.id, 'ytmusic stream unavailable', 'output');
        this.log.warn('ytmusic stream not ready; skipping playback', { zoneId: ctx.id });
      }
      return null;
    }
    this.prefetchNextQueueItem(ctx);
    return session;
  }

  private prefetchNextQueueItem(ctx: ZoneContext): void {
    if (!this.isLocalQueueAuthority(ctx.queue.authority)) {
      return;
    }
    if (ctx.queue.items.length === 0) {
      return;
    }
    const schedulePrefetch = (index: number): void => {
      if (index < 0 || index >= ctx.queue.items.length) {
        return;
      }
      const item = ctx.queue.items[index];
      if (!item) {
        return;
      }
      if (this.audioHelpers.isRadioAudiopath(item.audiopath, item.audiotype)) {
        return;
      }
      const isAppleMusic = this.audioHelpers.isAppleMusicAudiopath(item.audiopath);
      const isDeezer = this.audioHelpers.isDeezerAudiopath(item.audiopath);
      const isTidal = this.audioHelpers.isTidalAudiopath(item.audiopath);
      const isYtMusic = this.audioHelpers.isYtMusicAudiopath(item.audiopath);
      if (!isAppleMusic && !isDeezer && !isTidal && !isYtMusic) {
        return;
      }
      if (!this.isTrackAudiopath(item.audiopath)) {
        return;
      }
      void this.contentPort.resolvePlaybackSource({
        zoneId: ctx.id,
        zoneName: ctx.name,
        audiopath: item.audiopath,
        prefetch: true,
      }).catch((error) => {
        this.log.debug('next track prefetch failed', {
          zoneId: ctx.id,
          audiopath: item.audiopath,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };
    const nextIndex = ctx.queueController.nextIndex();
    if (nextIndex < 0) {
      return;
    }
    schedulePrefetch(nextIndex);
    schedulePrefetch(nextIndex + 1);
  }

  private hasPlaybackOutput(
    ctx: ZoneContext,
    classification: { isSpotify: boolean },
  ): boolean {
    const outputCandidates = ctx.outputs.filter((output) => output.type !== 'spotify-input');
    if (outputCandidates.length > 0) {
      return true;
    }
    const spotifyOffload = ctx.config.inputs?.spotify?.offload === true;
    if (classification.isSpotify && spotifyOffload) {
      return ctx.outputs.some((output) => output.type === 'spotify-input');
    }
    return false;
  }

  private computeOutputLatencyMs(outputs: ZoneOutput[]): number {
    return outputs
      .map((output) => output.getLatencyMs?.())
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      .reduce((max, value) => Math.max(max, value), 0);
  }

  private classifyAudiopath(audiopath: string): {
    isSpotify: boolean;
    isMusicAssistant: boolean;
    isAppleMusic: boolean;
    isDeezer: boolean;
    isTidal: boolean;
    isYtMusic: boolean;
    provider: ProviderKind;
    nextInput: ZoneContext['inputMode'];
  } {
    const isSpotify = this.audioHelpers.isSpotifyAudiopath(audiopath);
    const isMusicAssistant = this.audioHelpers.isMusicAssistantAudiopath(audiopath);
    const isAppleMusic = this.audioHelpers.isAppleMusicAudiopath(audiopath);
    const isDeezer = this.audioHelpers.isDeezerAudiopath(audiopath);
    const isTidal = this.audioHelpers.isTidalAudiopath(audiopath);
    const isYtMusic = this.audioHelpers.isYtMusicAudiopath(audiopath);
    const nextInput: ZoneContext['inputMode'] =
      isSpotify
        ? 'spotify'
        : isMusicAssistant
          ? 'musicassistant'
          : 'queue';
    const provider: ProviderKind = isAppleMusic
      ? 'applemusic'
      : isDeezer
        ? 'deezer'
        : isTidal
          ? 'tidal'
          : isYtMusic
            ? 'ytmusic'
          : null;
    return {
      isSpotify,
      isMusicAssistant,
      isAppleMusic,
      isDeezer,
      isTidal,
      isYtMusic,
      provider,
      nextInput,
    };
  }

  private applyPlaybackInputTransition(
    ctx: ZoneContext,
    nextInput: ZoneContext['inputMode'],
    options?: { skipExternalStop?: boolean },
  ): void {
    const prevInput = ctx.inputMode;
    this.setInputMode(ctx, nextInput);
    if (!options?.skipExternalStop) {
      this.stopExternalInputSessions(ctx.id, prevInput, nextInput);
    }
    if (nextInput !== 'spotify') {
      this.stopSpotifyOutputs(ctx.outputs);
    }
  }

  private buildEnrichedPlaybackMetadata(
    audiopath: string,
    metadata?: PlaybackMetadata,
  ): PlaybackMetadata {
    if (metadata && metadata.audiopath) {
      return metadata;
    }
    return { ...(metadata ?? { title: '', artist: '', album: '' }), audiopath };
  }

  public handleCommand(zoneId: number, command: string, payload?: string): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    if (command === 'next' || command === 'previous' || command === 'queueplus' || command === 'queueminus') {
      const currentAudiopath = ctx.queueController.current()?.audiopath ?? ctx.state.audiopath ?? '';
      if (this.radioParadise.isRadioParadiseAudiopath(currentAudiopath) && this.radioParadise.canSkip(ctx.id)) {
        const delta = command === 'previous' || command === 'queueminus' ? -1 : 1;
        void this.handleRadioParadiseSkip(ctx, delta);
        return;
      }
    }
    handleZoneCommand({
      coordinator: {
        log: this.log,
        applyPatch: this.applyPatch,
        dispatchOutputs: this.dispatchOutputs.bind(this),
        dispatchVolume: this.dispatchVolume.bind(this),
        dispatchQueueStep: this.dispatchQueueStep.bind(this),
        setInputMode: this.setInputMode.bind(this),
        setShuffle: this.queueController.setShuffle.bind(this.queueController),
        stepQueue: this.queueStepDispatcher.stepQueue.bind(this.queueStepDispatcher),
        isLocalQueueAuthority: this.isLocalQueueAuthority.bind(this),
        startQueuePlayback: this.startQueuePlayback.bind(this),
        audioHelpers: this.audioHelpers,
        remoteControl: (id, cmd) => this.inputsPort.remoteControl(id, cmd),
        remoteVolume: (id, volume) => this.inputsPort.remoteVolume(id, volume),
        playerCommand: (id, cmd, args) => this.inputsPort.playerCommand(id, cmd, args),
        requestLineInControl: (inputId, cmd) => this.inputsPort.requestLineInControl(inputId, cmd),
      },
      ctx,
      zoneId,
      command,
      payload,
    });
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
    handleUpdateOutputState({
      coordinator: {
        getZone: (id) => this.zoneRepo.get(id),
        audioHelpers: this.audioHelpers,
        applyPatch: this.applyPatch,
      },
      zoneId,
      state,
    });
  }

  public handlePlaybackError(
    zoneId: number,
    reason: string | undefined,
    source: 'player' | 'output',
    extraLog?: Record<string, unknown>,
  ): void {
    const ctx = this.zoneRepo.get(zoneId);
    const normalized = typeof reason === 'string' ? reason.trim().toLowerCase() : '';
    if (ctx && normalized.includes('end_of_track') && this.isLocalQueueAuthority(ctx.queue.authority)) {
      this.log.debug('treating end_of_track as queue advance', {
        zoneId,
        reason,
        source,
      });
      void this.queueStepDispatcher.handleEndOfTrack(ctx);
      return;
    }
    if (ctx) {
      ctx.lastPlaybackErrorAt = Date.now();
      ctx.lastPlaybackErrorReason = typeof reason === 'string' ? reason.trim() : undefined;
    }
    handlePlaybackErrorTransition({
      coordinator: {
        getZone: (id) => this.zoneRepo.get(id),
        applyPatch: this.applyPatch,
        log: this.log,
      },
      zoneId,
      reason,
      source,
      extraLog,
    });
  }

  private hasRecentPlaybackError(ctx: ZoneContext, windowMs = 2000): boolean {
    if (!ctx.lastPlaybackErrorAt) return false;
    if (Date.now() - ctx.lastPlaybackErrorAt > windowMs) return false;
    return Boolean(ctx.lastPlaybackErrorReason && ctx.lastPlaybackErrorReason.trim());
  }

  public setupPlayerListeners(
    player: ZoneContext['player'],
    outputs: ZoneOutput[],
    zoneId: number,
    zoneName: string,
    sourceMac: string,
  ): void {
    attachPlayerListeners({
      coordinator: {
        getZone: (id) => this.zoneRepo.get(id),
        applyPatch: this.applyPatch,
        dispatchOutputs: this.dispatchOutputs.bind(this),
        dispatchVolume: this.dispatchVolume.bind(this),
        buildAbsoluteCoverUrl: this.buildAbsoluteCoverUrl.bind(this),
        audioHelpers: this.audioHelpers,
        stopAlert: this.stopAlert,
        handleEndOfTrack: this.queueStepDispatcher.handleEndOfTrack.bind(this.queueStepDispatcher),
        handlePlaybackError: this.handlePlaybackError.bind(this),
        onCrossfadePosition: this.onCrossfadePosition.bind(this),
      },
      player,
      outputs,
      zoneId,
      zoneName,
      sourceMac,
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

  private prefetchPlaybackSource(ctx: ZoneContext, audiopath: string): void {
    if (this.audioHelpers.isRadioAudiopath(audiopath)) {
      return;
    }
    const isAppleMusic = this.audioHelpers.isAppleMusicAudiopath(audiopath);
    const isDeezer = this.audioHelpers.isDeezerAudiopath(audiopath);
    const isTidal = this.audioHelpers.isTidalAudiopath(audiopath);
    const isYtMusic = this.audioHelpers.isYtMusicAudiopath(audiopath);
    if (!isAppleMusic && !isDeezer && !isTidal && !isYtMusic) {
      return;
    }
    if (!this.isTrackAudiopath(audiopath)) {
      return;
    }
    void this.contentPort.resolvePlaybackSource({
      zoneId: ctx.id,
      zoneName: ctx.name,
      audiopath,
      prefetch: true,
    }).catch((error) => {
      this.log.debug('step prefetch failed', {
        zoneId: ctx.id,
        audiopath,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async advanceTrack(ctx: ZoneContext): Promise<void> {
    const cfState = this.crossfadeState.get(ctx.id);
    if (cfState?.triggered && cfState.triggeredAt > 0) {
      const elapsed = Date.now() - cfState.triggeredAt;
      const suppressMs = ((this.configPort.getSystemConfig()?.audioserver?.crossfadeSec ?? 5) + 5) * 1000;
      if (elapsed < suppressMs) {
        this.log.debug('end_of_track suppressed; crossfade already advanced queue', { zoneId: ctx.id });
        this.crossfadeState.delete(ctx.id);
        return;
      }
    }
    this.crossfadeState.delete(ctx.id);

    const currentAudiopath = ctx.queueController.current()?.audiopath ?? ctx.state.audiopath ?? '';
    if (this.radioParadise.isRadioParadiseAudiopath(currentAudiopath) && this.radioParadise.canSkip(ctx.id)) {
      const resolved = await this.radioParadise.resolveNextBlock(ctx.id);
      if (resolved) {
        const metadata = this.buildRadioParadiseMetadata(ctx, resolved);
        const session = await this.startQueuePlayback(ctx, resolved.url, metadata, {
          startAtSec: resolved.startAtSec,
          skipExternalStop: true,
        });
        if (session && resolved.track) {
          this.updateRadioMetadata(ctx.id, {
            title: resolved.track.title,
            artist: resolved.track.artist,
            coverurl: resolved.track.coverurl,
            duration: resolved.track.durationSec,
            controllable: true,
          });
        }
        return;
      }
    }
    await handleEndOfTrackTransition({
      coordinator: {
        getZone: (id) => this.zoneRepo.get(id),
        isLocalQueueAuthority: this.isLocalQueueAuthority.bind(this),
        startQueuePlayback: this.startQueuePlayback.bind(this),
        applyPatch: this.applyPatch,
        dispatchOutputs: this.dispatchOutputs.bind(this),
        recentsRecord: this.recentsManager.record.bind(this.recentsManager),
        audioHelpers: this.audioHelpers,
      },
      ctx,
    });
  }

  private async handleRadioParadiseSkip(ctx: ZoneContext, delta: 1 | -1): Promise<void> {
    const timeSec = Number(ctx.player.getState().time) || 0;
    const resolved = await this.radioParadise.resolveSkip(ctx.id, timeSec, delta);
    if (!resolved) {
      return;
    }
    const metadata = this.buildRadioParadiseMetadata(ctx, resolved);
    const session = await this.startQueuePlayback(ctx, resolved.url, metadata, {
      startAtSec: resolved.startAtSec,
      skipExternalStop: true,
    });
    if (session && resolved.track) {
      this.updateRadioMetadata(ctx.id, {
        title: resolved.track.title,
        artist: resolved.track.artist,
        coverurl: resolved.track.coverurl,
        duration: resolved.track.durationSec,
        controllable: true,
      });
    }
  }

  public onCrossfadePosition(zoneId: number, time: number, duration: number): void {
    if (!duration || duration <= 0) return;
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx || ctx.alert || ctx.inputMode === 'alert') return;
    const crossfadeSec = this.configPort.getSystemConfig()?.audioserver?.crossfadeSec;
    if (!crossfadeSec || crossfadeSec <= 0) return;
    if (!this.isLocalQueueAuthority(ctx.queue.authority)) return;
    const session = this.audioManager.getSession(zoneId);
    const srcKind = session?.playbackSource?.kind;
    if (!srcKind) return;
    if (session.metadata?.isRadio) return;

    const remaining = duration - time;
    if (remaining <= 0) return;

    // After an inline crossfade Squeezelite's elapsed and the zone timer are both anchored
    // to the OLD song's timeline (Squeezelite never reconnected).  session.crossfadedAt is
    // set by audioManager right after the blend completes; use it as the only reliable
    // clock for the NEW song's position so we don't fire the next crossfade immediately.
    let accurateElapsed: number;
    if (session?.crossfadedAt) {
      accurateElapsed = (Date.now() - session.crossfadedAt) / 1000;
    } else {
      // Normal (non-crossfaded) session: use the best available elapsed estimate.
      // - session.startedAt gives a wall-clock anchor with no lag.
      // - session.elapsed from Squeezelite is accurate on state changes.
      // - `time` from zone timer lags VLC by ~5-13 s (VLC buffering).
      const wallClockElapsedSec = session?.startedAt
        ? (Date.now() - session.startedAt) / 1000
        : time;
      const squeezeliteElapsed =
        typeof session?.elapsed === 'number' && session.elapsed > 0 ? session.elapsed : 0;
      // When squeezeliteElapsed is 0 the zone timer may carry a stale position — clamp.
      const sanitizedTime = squeezeliteElapsed > 0 ? time : Math.min(time, wallClockElapsedSec);
      accurateElapsed = Math.max(wallClockElapsedSec, squeezeliteElapsed, sanitizedTime);
    }
    const accurateDuration = session?.metadata?.duration ?? duration;
    const accurateRemaining = accurateDuration - accurateElapsed;

    const state = this.crossfadeState.get(zoneId);

    if (accurateRemaining <= crossfadeSec + this.CROSSFADE_PRE_RESOLVE_EXTRA_SEC && !state?.resolving && !state?.triggered) {
      void this.startCrossfadePreResolve(ctx, crossfadeSec);
    }

    if (accurateRemaining <= crossfadeSec && state?.resolvedSource && !state.triggered) {
      void this.triggerCrossfade(ctx, crossfadeSec);
    }
  }

  private async startCrossfadePreResolve(ctx: ZoneContext, crossfadeSec: number): Promise<void> {
    const zoneId = ctx.id;
    const nextIndex = ctx.queueController.nextIndex();
    if (nextIndex < 0) return;
    const nextItem = ctx.queue.items[nextIndex];
    if (!nextItem) return;
    if (this.audioHelpers.isRadioAudiopath(nextItem.audiopath, nextItem.audiotype)) return;
    if (this.audioHelpers.isMusicAssistantAudiopath(nextItem.audiopath)) return;

    const isSpotifyNext = this.audioHelpers.isSpotifyAudiopath(nextItem.audiopath);

    this.crossfadeState.set(zoneId, {
      resolving: true,
      resolvedSource: null,
      resolvedMetadata: null,
      nextAudiopath: nextItem.audiopath,
      nextQueueIndex: nextIndex,
      triggered: false,
      triggeredAt: 0,
      isSpotifyFadeIn: isSpotifyNext,
    });

    try {
      const resolvedMetadata: PlaybackMetadata = {
        title: nextItem.title || '',
        artist: nextItem.artist || '',
        album: nextItem.album || '',
        coverurl: nextItem.coverurl,
        duration: nextItem.duration,
        audiopath: nextItem.audiopath,
        station: nextItem.station,
        isRadio: false,
      };

      let resolvedSource: PlaybackSource | null = null;

      if (isSpotifyNext) {
        // For Spotify fade-in the stream is started at trigger time, not pre-resolve.
        // Use a sentinel pipe source so `resolvedSource` is truthy and the trigger fires.
        resolvedSource = { kind: 'pipe', path: 'spotify-xf-pending' };
      } else {
        const isAppleMusic = this.audioHelpers.isAppleMusicAudiopath(nextItem.audiopath);
        const isDeezer = this.audioHelpers.isDeezerAudiopath(nextItem.audiopath);
        const isTidal = this.audioHelpers.isTidalAudiopath(nextItem.audiopath);
        const isYtMusic = this.audioHelpers.isYtMusicAudiopath(nextItem.audiopath);

        if (isAppleMusic || isDeezer || isTidal || isYtMusic) {
          const resolution = await this.contentPort
            .resolvePlaybackSource({ zoneId, zoneName: ctx.name, audiopath: nextItem.audiopath })
            .catch(() => null);
          resolvedSource = resolution?.playbackSource ?? null;
        } else {
          resolvedSource = resolvePlaybackSource(nextItem.audiopath);
        }
      }

      const current = this.crossfadeState.get(zoneId);
      if (!current || current.nextAudiopath !== nextItem.audiopath) return;

      if (!resolvedSource || (!isSpotifyNext && resolvedSource.kind === 'pipe')) {
        this.crossfadeState.delete(zoneId);
        return;
      }

      current.resolving = false;
      current.resolvedSource = resolvedSource;
      current.resolvedMetadata = resolvedMetadata;

      // Eager trigger: if accurate elapsed already crossed the crossfade window while
      // we were resolving (async services), fire immediately rather than waiting for
      // the next zone-timer tick.
      if (!current.triggered) {
        const session = this.audioManager.getSession(zoneId);
        const accurateElapsed =
          typeof session?.elapsed === 'number' && session.elapsed > 0
            ? session.elapsed
            : ctx.player.getState().time;
        const accurateDuration = session?.metadata?.duration ?? ctx.player.getState().duration ?? 0;
        const remaining = accurateDuration - accurateElapsed;
        if (remaining > 0 && remaining <= crossfadeSec) {
          void this.triggerCrossfade(ctx, crossfadeSec);
        }
      }
    } catch {
      this.crossfadeState.delete(zoneId);
    }
  }

  private async triggerCrossfade(ctx: ZoneContext, crossfadeSec: number): Promise<void> {
    const zoneId = ctx.id;
    const state = this.crossfadeState.get(zoneId);
    if (!state?.resolvedSource || state.triggered) return;
    state.triggered = true;
    state.triggeredAt = Date.now();

    const newSource = state.resolvedSource;

    type FadeIn =
      | { kind: 'file'; path: string }
      | { kind: 'url'; url: string; headers?: Record<string, string>; decryptionKey?: string }
      | { kind: 'pipe'; stream: NodeJS.ReadableStream; sampleRate: number; channels: number };

    let fadeIn: FadeIn;
    let nextPlaybackSource: PlaybackSource = newSource;

    if (state.isSpotifyFadeIn) {
      // Start the next Spotify track on the crossfade session now (at blend start time).
      const xfStream = await this.inputsPort.startCrossfadeStream(zoneId, state.nextAudiopath);
      if (!xfStream) {
        state.triggered = false;
        this.crossfadeState.delete(zoneId);
        return;
      }
      fadeIn = { kind: 'pipe', stream: xfStream.stream, sampleRate: xfStream.sampleRate, channels: xfStream.channels };
      nextPlaybackSource = {
        kind: 'pipe',
        path: `librespot-native-${zoneId}`,
        format: 's16le',
        sampleRate: xfStream.sampleRate,
        channels: xfStream.channels,
        realTime: false,
        stream: xfStream.stream,
      };
    } else if (newSource.kind === 'file') {
      fadeIn = { kind: 'file', path: newSource.path };
    } else if (newSource.kind === 'url') {
      fadeIn = {
        kind: 'url',
        url: newSource.url,
        headers: (newSource as Extract<PlaybackSource, { kind: 'url' }>).headers,
        decryptionKey: (newSource as Extract<PlaybackSource, { kind: 'url' }>).decryptionKey,
      };
    } else {
      this.crossfadeState.delete(zoneId);
      return;
    }

    // Kick off the blend WITHOUT awaiting yet. The synchronous prologue inside
    // inlineCrossfadePlayback updates session.metadata/duration/crossfadedAt and
    // returns a promise that resolves when the actual PCM blend completes
    // ~`crossfadeSec` seconds from now.
    const blendPromise = this.audioManager.inlineCrossfadePlayback(
      zoneId,
      fadeIn,
      crossfadeSec,
      nextPlaybackSource,
      state.resolvedMetadata ?? undefined,
    );

    // Hand audio-session ownership to the crossfade target IMMEDIATELY (before the
    // 10 s blend) so the spotify input service starts ignoring Connect-host events
    // for the OLD track right away. Otherwise periodic Connect events fired during
    // the blend would call applyMetadataUpdate() and revert session.metadata back
    // to the old title/duration — corrupting the URL handover that runs after the
    // blend, and skewing the next-crossfade trigger time.
    if (state.isSpotifyFadeIn) {
      this.inputsPort.releaseCrossfadeStream(zoneId, state.resolvedMetadata ?? undefined);
    }

    // The session has already been mutated synchronously above. Read it now so we
    // can flip the visible player state to the NEW track at fade-in start (instead
    // of after the 10 s blend completes). Without this the audio_event keeps the
    // OLD title/artist/cover until the blend is finished.
    const earlySession = this.audioManager.getSession(zoneId);
    if (earlySession) {
      ctx.queueController.setCurrentIndex(state.nextQueueIndex);
      // Player state: title, duration, time=0 — same call we used to make AFTER
      // the blend, just moved earlier. The HTTP stream URL does not change so
      // squeezelite is unaffected.
      ctx.player.updateStateForCrossfade(earlySession);
      const nextItem = ctx.queue.items[state.nextQueueIndex];
      if (nextItem) {
        const patch = buildQueueItemPlaybackPatch(ctx, nextItem, state.nextQueueIndex, this.audioHelpers);
        this.applyPatch(zoneId, {
          ...patch,
          mode: 'play',
          clientState: 'on',
          power: 'on',
          time: 0,
          duration: typeof nextItem.duration === 'number' ? Math.max(0, Math.round(nextItem.duration)) : undefined,
        });
        void this.recentsManager.record(zoneId, nextItem);
      }
    }

    const crossfadeSession = await blendPromise;
    if (!crossfadeSession) {
      state.triggered = false;
      this.crossfadeState.delete(zoneId);
      return;
    }

    // Clear crossfade state once the blend has actually completed. handleEndOfTrack
    // must not suppress a future queue advance when song B eventually finishes,
    // since no separate "song A ended" event fires (the session continues inline).
    this.crossfadeState.delete(zoneId);

    // Gapless URL handover for HTTP-URL outputs (currently squeezelite only).
    // The audio session keeps its PCM pipeline + encoder unchanged across the blend,
    // but we rotate the stream id so the output reconnects to a fresh URL with fresh
    // metadata. Squeezelite's elapsed-vs-duration tracking would otherwise drift on a
    // single long URL and eventually misbehave (stuck buffering after upstream stalls).
    void this.runUrlHandover(ctx, crossfadeSession);

    this.log.info('crossfade triggered', {
      zoneId,
      crossfadeSec,
      next: state.nextAudiopath,
    });
  }

  /**
   * Phase-1 URL handover: rotates the audio session's stream id, asks each capable
   * output to enqueue the new URL as the next track, then closes the OLD URL's HTTP
   * response after a short pre-buffer window so the output transitions naturally.
   *
   * Outputs that don't implement `enqueueRotation` are skipped — they either don't
   * use HTTP URLs (Sendspin/Snapcast/AirPlay) or haven't been wired up for the
   * gapless handover yet (DLNA/Sonos/Cast — Phase 2).
   */
  private async runUrlHandover(ctx: ZoneContext, session: PlaybackSession): Promise<void> {
    const candidates = ctx.outputs.filter((o) => typeof o.enqueueRotation === 'function');
    if (candidates.length === 0) return;
    const rotation = this.audioManager.rotateStreamId(ctx.id);
    if (!rotation) return;
    // Re-fetch the session AFTER rotation so it carries the new stream.url.
    const rotatedSession = this.audioManager.getSession(ctx.id);
    if (!rotatedSession) return;
    let enqueuedAtLeastOne = false;
    for (const output of candidates) {
      try {
        const ok = await output.enqueueRotation!(rotatedSession);
        if (ok) enqueuedAtLeastOne = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('output enqueueRotation failed', { zoneId: ctx.id, type: output.type, message });
      }
    }
    if (!enqueuedAtLeastOne) {
      // No output accepted the handover (e.g., grouped playback). The OLD URL stays
      // open and the recentStreamIds entry just expires harmlessly.
      this.log.debug('url handover skipped — no output accepted enqueue', { zoneId: ctx.id });
      return;
    }
    // Give the output a moment to receive the slimproto frame, open a TCP connection
    // to the new URL, and pre-buffer enough FLAC frames that an EOF on the old URL
    // doesn't cause an audible underrun. The squeezelite `expect=1` param sets the
    // network buffer threshold to ~32 KB (~200 ms of audio); 700 ms gives squeezelite
    // ~3.5× that threshold to pre-buffer the new URL while still keeping the OLD URL
    // alive briefly enough to minimise the perceptible stutter at handover. Earlier
    // 1500 ms was safe but produced an audible 1–3 s buffering window when the OLD
    // librespot stalled at the same time as the rotation.
    setTimeout(() => {
      try {
        this.audioManager.closeSubscribersForStreamId(ctx.id, rotation.oldId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('closeSubscribersForStreamId failed', {
          zoneId: ctx.id,
          oldId: rotation.oldId,
          message,
        });
      }
    }, 700);
  }

  private buildRadioParadiseMetadata(
    ctx: ZoneContext,
    resolved: {
      track?: { title: string; artist: string; album: string; coverurl?: string; durationSec?: number };
      blockDurationSec: number;
      stationLabel: string;
      isRadio: boolean;
    },
  ): PlaybackMetadata {
    const base: PlaybackMetadata = { title: '', artist: '', album: '' };
    const current = ctx.queueController.current();
    const audiopath = current?.audiopath ?? ctx.state.audiopath ?? '';
    const track = resolved.track;
    return {
      ...base,
      isRadio: resolved.isRadio,
      title: track?.title ?? base.title,
      artist: track?.artist ?? base.artist,
      album: track?.album ?? base.album,
      coverurl: track?.coverurl,
      duration: track?.durationSec ?? base.duration,
      station: resolved.stationLabel,
      audiopath,
    };
  }

  private reorderQueue(
    ctx: ZoneContext,
    mode: 'shuffle' | 'unshuffle',
    opts: { keepCurrent: boolean; shuffleUpcoming?: boolean },
  ): void {
    this.queueController.reorderQueue(ctx, mode, opts);
  }
}
