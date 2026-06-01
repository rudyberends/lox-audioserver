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
import { audioOutputSettings } from '@/ports/types/audioFormat';
import { computePreferredPlaybackSettings } from '@/application/playback/policies/OutputFormatPolicy';
import { applyPreferredPlaybackSettings } from '@/application/playback/PlaybackSettingsApplier';
import { buildPlaybackPlan } from '@/application/playback/buildPlaybackPlan';
import { executePlaybackPlan } from '@/application/playback/executePlaybackPlan';
import type { ProviderKind } from '@/application/playback/types/PlaybackPlan';
import { OutputRouter } from '@/application/zones/OutputRouter';
import { QueueController as ZoneQueueController } from '@/application/zones/QueueController';
import { type ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';
import {
  setMusicAssistantProviderId,
  MUSIC_ASSISTANT_PROVIDER_DEFAULT,
} from '@/application/zones/internal/musicAssistantProvider';
import { ZoneRepository } from '@/application/zones/ZoneRepository';
import type { ConfigPort } from '@/ports/ConfigPort';
import { attachPlayerListeners } from '@/application/zones/playback/playerListeners';
import { handleZoneCommand } from '@/application/zones/playback/commandHandlers';
import { QueueStepDispatcher } from '@/application/zones/playback/QueueStepDispatcher';
import { CrossfadeController } from '@/application/zones/playback/crossfadeController';
import { PlayRequestService } from '@/application/zones/playback/playRequestService';
import { QueueAdvanceController } from '@/application/zones/playback/queueAdvanceController';
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
  private readonly crossfade: CrossfadeController;
  private readonly playRequest: PlayRequestService;
  private readonly queueAdvance: QueueAdvanceController;
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
      startQueuePlayback: (...args) => this.startQueuePlayback(...args),
      prefetchPlaybackSource: this.prefetchPlaybackSource.bind(this),
      advanceTrack: (ctx) => this.queueAdvance.advanceTrack(ctx),
    });
    this.crossfade = new CrossfadeController({
      zoneRepo: this.zoneRepo,
      audioManager: this.audioManager,
      audioHelpers: this.audioHelpers,
      contentPort: this.contentPort,
      configPort: this.configPort,
      inputsPort: this.inputsPort,
      recentsManager: this.recentsManager,
      log: this.log,
      applyPatch: this.applyPatch,
      isLocalQueueAuthority: this.isLocalQueueAuthority.bind(this),
      dispatchOutputs: this.dispatchOutputs.bind(this),
      startQueuePlayback: (...args) => this.startQueuePlayback(...args),
    });
    this.playRequest = new PlayRequestService({
      zoneRepo: this.zoneRepo,
      queueController: this.queueController,
      audioManager: this.audioManager,
      audioHelpers: this.audioHelpers,
      contentPort: this.contentPort,
      notifier: this.notifier,
      recentsManager: this.recentsManager,
      log: this.log,
      applyPatch: this.applyPatch,
      startQueuePlayback: (...args) => this.startQueuePlayback(...args),
      stopExternalInputSessions: this.stopExternalInputSessions.bind(this),
      prefetchNextQueueItem: (ctx) => this.queueAdvance.prefetchNext(ctx),
      dispatchOutputs: this.dispatchOutputs.bind(this),
      consumeMissingOutputFlag: (zoneId) => {
        const had = this.zonesMissingOutput.has(zoneId);
        if (had) this.zonesMissingOutput.delete(zoneId);
        return had;
      },
    });
    this.queueAdvance = new QueueAdvanceController({
      zoneRepo: this.zoneRepo,
      audioManager: this.audioManager,
      audioHelpers: this.audioHelpers,
      contentPort: this.contentPort,
      configPort: this.configPort,
      recentsManager: this.recentsManager,
      radioParadise: this.radioParadise,
      crossfade: this.crossfade,
      log: this.log,
      applyPatch: this.applyPatch,
      isLocalQueueAuthority: this.isLocalQueueAuthority.bind(this),
      dispatchOutputs: this.dispatchOutputs.bind(this),
      startQueuePlayback: (...args) => this.startQueuePlayback(...args),
      updateRadioMetadata: this.updateRadioMetadata.bind(this),
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
    // Align the engine output format with the target output's preferred format BEFORE starting.
    // The queue path does this via computePreferredPlaybackSettings; the input/connect path
    // (e.g. Spotify Connect) skipped it, so the engine started at the default rate and then
    // restarted mid-stream to match the sink (e.g. a sendspin client at 48 kHz/24-bit). That
    // format-mismatch restart (reason=replace) races with source churn and can leave the sink
    // with a started-but-starved stream — an audible dmix loop / noise.
    const ctx = this.zoneRepo.get(zoneId);
    if (ctx) {
      const settings = computePreferredPlaybackSettings({
        zoneId,
        zoneName: ctx.name,
        audiopath: metadata?.audiopath ?? label,
        isRadio: false,
        queueAuthority: ctx.queue?.authority,
        outputs: ctx.outputs,
        activeOutputType: ctx.activeOutput,
        defaults: audioOutputSettings,
      });
      applyPreferredPlaybackSettings(this.zoneAudioPrefs, zoneId, settings);
    }
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
    return this.playRequest.play(zoneId, uri, type, metadata, options);
  }

  public async startQueuePlayback(
    ctx: ZoneContext,
    audiopath: string,
    metadata?: PlaybackMetadata,
    options?: { skipExternalStop?: boolean; startAtSec?: number },
  ): Promise<PlaybackSession | null> {
    this.crossfade.clear(ctx.id);
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
    // Broadcast Loading… immediately so the Loxone app shows feedback before
    // yt-dlp resolves the stream URL (~5-7 s for YouTube/ytmusic).
    if (classification.isYoutube || classification.isYtMusic) {
      this.notifier.notifyZoneStateChanged({
        ...ctx.state,
        mode: 'play',
        title: 'Loading…',
        artist: '',
        album: '',
        coverurl: '',
        duration: 0,
        time: 0,
        audiotype: 5,
        audiopath,
      });
    }
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
      } else if (plan.provider === 'youtube') {
        this.handlePlaybackError(ctx.id, 'youtube stream unavailable', 'output');
        this.log.warn('youtube stream not ready; skipping playback', { zoneId: ctx.id });
      }
      return null;
    }
    this.queueAdvance.prefetchNext(ctx);
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
    isYtMusic: boolean;
    isYoutube: boolean;
    provider: ProviderKind;
    nextInput: ZoneContext['inputMode'];
  } {
    const isSpotify = this.audioHelpers.isSpotifyAudiopath(audiopath);
    const isMusicAssistant = this.audioHelpers.isMusicAssistantAudiopath(audiopath);
    const isAppleMusic = this.audioHelpers.isAppleMusicAudiopath(audiopath);
    const isDeezer = this.audioHelpers.isDeezerAudiopath(audiopath);
    const isTidal = this.audioHelpers.isTidalAudiopath(audiopath);
    const isYtMusic = this.audioHelpers.isYtMusicAudiopath(audiopath);
    const isYoutube = this.audioHelpers.isYoutubeAudiopath(audiopath);
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
          : isYoutube
            ? 'youtube'
          : null;
    return {
      isSpotify,
      isMusicAssistant,
      isAppleMusic,
      isDeezer,
      isTidal,
      isYtMusic,
      isYoutube,
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
        void this.queueAdvance.radioParadiseSkip(ctx, delta);
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
        startQueuePlayback: (...args) => this.startQueuePlayback(...args),
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
    const isYoutube = this.audioHelpers.isYoutubeAudiopath(audiopath);
    if (!isAppleMusic && !isDeezer && !isTidal && !isYtMusic && !isYoutube) {
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

  public onCrossfadePosition(zoneId: number, time: number, duration: number): void {
    this.crossfade.onPosition(zoneId, time, duration);
  }


  private isTrackAudiopath(audiopath: string): boolean {
    return /:track:|:library-track:/i.test(audiopath);
  }
}
