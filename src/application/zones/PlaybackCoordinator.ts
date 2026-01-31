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
import { handleZoneCommand } from '@/application/zones/playback/commandHandlers';
import {
  handleEndOfTrack as handleEndOfTrackTransition,
  stepQueueAsync as stepQueueAsyncTransition,
} from '@/application/zones/playback/queueTransitions';
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
  private readonly zonesMissingOutput = new Set<number>();
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

  public updateRadioMetadata(zoneId: number, metadata: { title: string; artist: string }): void {
    handleUpdateRadioMetadata({
      coordinator: this.buildInputCoordinator(),
      zoneId,
      metadata,
    });
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

    const queueBuild = await this.rebuildQueue(ctx, req, metadata);
    await this.startFromCurrentQueueItem(ctx, req, queueBuild, options?.startAtSec);
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
      this.handleUnplayableSource(ctx, current.audiopath);
    }
    return true;
  }

  private async rebuildQueue(
    ctx: ZoneContext,
    req: ResolvedPlayRequest,
    metadata?: PlaybackMetadata,
  ): Promise<QueueBuildResult> {
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
    return queueBuild;
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
        : { mode: 'stop', clientState: 'off', power: 'off' },
    );
    this.dispatchOutputs(ctx, ctx.outputs, 'stop', null);
  }

  public async startQueuePlayback(
    ctx: ZoneContext,
    audiopath: string,
    metadata?: PlaybackMetadata,
    options?: { skipExternalStop?: boolean; startAtSec?: number },
  ): Promise<PlaybackSession | null> {
    const classification = this.classifyAudiopath(audiopath);
    if (!this.hasPlaybackOutput(ctx, classification)) {
      this.zonesMissingOutput.add(ctx.id);
      this.handlePlaybackError(ctx.id, 'No output configured', 'output');
      this.log.warn('playback blocked; no output configured', {
        zoneId: ctx.id,
        audiopath,
      });
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
      audiopath,
      isRadio,
      queueAuthority: ctx.queue.authority,
      outputs: ctx.outputs,
      activeOutputType: ctx.activeOutput,
      defaults: audioOutputSettings,
    });
    this.applyPlaybackInputTransition(ctx, classification.nextInput, {
      skipExternalStop: options?.skipExternalStop,
    });
    const enrichedMetadata = this.buildEnrichedPlaybackMetadata(audiopath, metadata);
    const provider: ProviderKind = classification.provider;
    const plan = buildPlaybackPlan({
      ctx,
      audiopath,
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
      audioManager: this.audioManager,
      startAtSec: options?.startAtSec,
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
    provider: ProviderKind;
    nextInput: ZoneContext['inputMode'];
  } {
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
    const provider: ProviderKind = isAppleMusic
      ? 'applemusic'
      : isDeezer
        ? 'deezer'
        : isTidal
          ? 'tidal'
          : null;
    return {
      isSpotify,
      isMusicAssistant,
      isAppleMusic,
      isDeezer,
      isTidal,
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
    handleZoneCommand({
      coordinator: {
        log: this.log,
        applyPatch: this.applyPatch,
        dispatchOutputs: this.dispatchOutputs.bind(this),
        dispatchVolume: this.dispatchVolume.bind(this),
        dispatchQueueStep: this.dispatchQueueStep.bind(this),
        setInputMode: this.setInputMode.bind(this),
        setShuffle: this.queueController.setShuffle.bind(this.queueController),
        stepQueue: this.stepQueue.bind(this),
        isLocalQueueAuthority: this.isLocalQueueAuthority.bind(this),
        startQueuePlayback: this.startQueuePlayback.bind(this),
        audioHelpers: this.audioHelpers,
        remoteControl: (id, cmd) => this.inputsPort.remoteControl(id, cmd),
        remoteVolume: (id, volume) => this.inputsPort.remoteVolume(id, volume),
        playerCommand: (id, cmd, args) => this.inputsPort.playerCommand(id, cmd, args),
        requestLineInControl: (inputId, cmd) => this.inputsPort.requestLineInControl(inputId, cmd),
        getVolumeOrigin: this.getVolumeOrigin.bind(this),
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
      void this.handleEndOfTrack(ctx);
      return;
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
        handleEndOfTrack: this.handleEndOfTrack.bind(this),
        handlePlaybackError: this.handlePlaybackError.bind(this),
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

  private stepQueue(zoneId: number, delta: number): void {
    void stepQueueAsyncTransition({
      coordinator: {
        getZone: (id) => this.zoneRepo.get(id),
        isLocalQueueAuthority: this.isLocalQueueAuthority.bind(this),
        startQueuePlayback: this.startQueuePlayback.bind(this),
        applyPatch: this.applyPatch,
        dispatchOutputs: this.dispatchOutputs.bind(this),
        recentsRecord: this.recentsManager.record.bind(this.recentsManager),
        audioHelpers: this.audioHelpers,
      },
      zoneId,
      delta,
    });
  }

  private async handleEndOfTrack(ctx: ZoneContext): Promise<void> {
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

  private reorderQueue(
    ctx: ZoneContext,
    mode: 'shuffle' | 'unshuffle',
    opts: { keepCurrent: boolean; shuffleUpcoming?: boolean },
  ): void {
    this.queueController.reorderQueue(ctx, mode, opts);
  }
}
