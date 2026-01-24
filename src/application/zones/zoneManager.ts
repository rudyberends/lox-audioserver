import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { ZoneConfig, InputConfig } from '@/domain/config/types';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ContentPort } from '@/ports/ContentPort';
import {
  type AudioManager,
  type PlaybackMetadata,
  type PlaybackSession,
  type PlaybackSource,
  type CoverArtPayload,
} from '@/application/playback/audioManager';
import { ZonePlayer } from '@/application/playback/zonePlayer';
import { QueueController as PlaybackQueueController } from '@/application/playback/queueController';
import { QueueController as ZoneQueueController } from '@/application/zones/QueueController';
import { OutputRouter } from '@/application/zones/OutputRouter';
import { GroupingCoordinator } from '@/application/zones/GroupingCoordinator';
import { PlaybackCoordinator } from '@/application/zones/PlaybackCoordinator';
import { AlertsCoordinator } from '@/application/zones/AlertsCoordinator';
import { InputAdapter } from '@/application/playback/inputAdapter';
import { SpotifyInputAdapter } from '@/application/playback/adapters/SpotifyInputAdapter';
import { registerPlayer, unregisterPlayer, clearPlayers } from '@/application/playback/playerRegistry';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { MixedGroupCoordinator } from '@/application/groups/mixedGroupController';
import type { OutputsPort } from '@/ports/OutputsPort';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import type { InputsPort } from '@/ports/InputsPort';
import type {
  AlertSnapshot,
  QueueItem,
  QueueAuthority,
  QueueState,
  ZoneContext,
} from '@/application/zones/internal/zoneTypes';
import { ZoneStateStore } from '@/application/zones/ZoneStateStore';
import { ZoneRepository } from '@/application/zones/ZoneRepository';
import type { AlertMediaResource } from '@/application/alerts/types';
import {
  buildInitialState,
  getZoneDefaultVolume,
} from '@/application/zones/helpers/stateHelpers';
import {
  createZoneAudioHelpers,
  type ZoneAudioHelpers,
} from '@/application/zones/internal/zoneAudioHelpers';
import { getMusicAssistantUserId } from '@/application/zones/internal/musicAssistantProvider';

export type {
  AlertSnapshot,
  QueueItem,
  QueueAuthority,
  QueueState,
  ZoneContext,
} from '@/application/zones/internal/zoneTypes';

type QueueUpdateHandler = (zoneId: number, items: QueueItem[], currentIndex: number) => void;

type OutputState = {
  status?: 'playing' | 'paused' | 'stopped';
  position?: number;
  duration?: number;
  uri?: string;
};

type OutputErrorHandler = (zoneId: number, reason?: string) => void;

type OutputStateHandler = (zoneId: number, state: OutputState) => void;

type OutputHandlers = {
  onQueueUpdate: QueueUpdateHandler;
  onOutputError: OutputErrorHandler;
  onOutputState: OutputStateHandler;
};

export class ZoneManager {
  private readonly log = createLogger('Zones', 'Manager');
  private readonly zoneRepo = new ZoneRepository();
  private readonly stateStore: ZoneStateStore;
  private readonly queueController: ZoneQueueController;
  private readonly outputRouter: OutputRouter;
  private readonly groupingCoordinator: GroupingCoordinator;
  private readonly playbackCoordinator: PlaybackCoordinator;
  private readonly alertsCoordinator: AlertsCoordinator;
  private readonly inputsPort: InputsPort;
  private readonly audioHelpers: ZoneAudioHelpers;
  private readonly outputsPort: OutputsPort;
  private readonly contentPort: ContentPort;
  private readonly configPort: ConfigPort;
  private readonly audioManager: AudioManager;
  private initialized = false;
  private inputsConfigured = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private notifier: NotifierPort;

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }
    const intervalMs = 60_000;
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const ctx of this.zoneRepo.list()) {
        if (!ctx.state) {
          continue;
        }
        ctx.lastZoneBroadcastAt = now;
        this.notifier.notifyZoneStateChanged(ctx.state);
      }
    }, intervalMs);
  }

  /** Read-only snapshot of the current zone state for external consumers (e.g. outputs). */
  public getZoneState(zoneId: number): LoxoneZoneState | null {
    return this.stateStore.getZoneState(zoneId);
  }

  private outputsRequirePcm(outputs: ZoneOutput[]): boolean {
    return outputs.some((output) => this.outputTypeRequiresPcm(output.type));
  }

  private outputTypeRequiresPcm(type: string): boolean {
    return type === 'airplay' || type === 'sendspin' || type === 'sendspin-cast' || type === 'snapcast';
  }

  constructor(
    notifier: NotifierPort,
    inputsPort: InputsPort,
    outputsPort: OutputsPort,
    contentPort: ContentPort,
    configPort: ConfigPort,
    recentsManager: RecentsManager,
    audioManager: AudioManager,
    mixedGroup: MixedGroupCoordinator | null = null,
  ) {
    this.notifier = notifier;
    this.inputsPort = inputsPort;
    this.outputsPort = outputsPort;
    this.contentPort = contentPort;
    this.configPort = configPort;
    this.audioManager = audioManager;
    this.audioHelpers = createZoneAudioHelpers(contentPort, configPort);
    const audioHelpers = this.audioHelpers;
    const notifierProxy: NotifierPort = {
      notifyZoneStateChanged: (state) => this.notifier.notifyZoneStateChanged(state),
      notifyQueueUpdated: (zoneId, queueSize) =>
        this.notifier.notifyQueueUpdated(zoneId, queueSize),
      notifyRoomFavoritesChanged: (zoneId, count) =>
        this.notifier.notifyRoomFavoritesChanged(zoneId, count),
      notifyRecentlyPlayedChanged: (zoneId, timestamp) =>
        this.notifier.notifyRecentlyPlayedChanged(zoneId, timestamp),
      notifyRescan: (status, folders, files) =>
        this.notifier.notifyRescan(status, folders, files),
      notifyReloadMusicApp: (action, provider, userId) =>
        this.notifier.notifyReloadMusicApp(action, provider, userId),
      notifyAudioSyncEvent: (payload) => this.notifier.notifyAudioSyncEvent(payload),
    };
    this.groupingCoordinator = new GroupingCoordinator({
      getState: (zoneId) => this.getState(zoneId),
      applyPatch: (zoneId, patch, force) => this.applyPatch(zoneId, patch, force),
    });
    this.stateStore = new ZoneStateStore(this.zoneRepo, {
      isRadioAudiopath: audioHelpers.isRadioAudiopath,
      isLineInAudiopath: audioHelpers.isLineInAudiopath,
      syncGroupMembersPatch: (leaderId, patch, force) =>
        this.groupingCoordinator.syncGroupMembersPatch(leaderId, patch, force),
      onStatePatch: mixedGroup
        ? (zoneId, patch, nextState) => mixedGroup.handleStatePatch(zoneId, patch, nextState)
        : undefined,
      notifyOutputMetadata: (zoneId, ctx, patch) =>
        this.notifyOutputMetadata(zoneId, ctx, patch),
      notifier: notifierProxy,
      audioManager: this.audioManager,
    });
    this.queueController = new ZoneQueueController(this.zoneRepo, {
      log: this.log,
      contentPort: this.contentPort,
      applyPatch: (zoneId, patch, force) => this.applyPatch(zoneId, patch, force),
      isRadioAudiopath: audioHelpers.isRadioAudiopath,
      isSpotifyAudiopath: audioHelpers.isSpotifyAudiopath,
      isMusicAssistantAudiopath: audioHelpers.isMusicAssistantAudiopath,
      isAppleMusicAudiopath: audioHelpers.isAppleMusicAudiopath,
      isDeezerAudiopath: audioHelpers.isDeezerAudiopath,
      isTidalAudiopath: audioHelpers.isTidalAudiopath,
      resolveBridgeProvider: audioHelpers.resolveBridgeProvider,
      getMusicAssistantUserId,
      getStateAudiotype: audioHelpers.getStateAudiotype,
      getStateFileType: audioHelpers.getStateFileType,
      resolveSourceName: audioHelpers.resolveSourceName,
      notifier: notifierProxy,
    });
    this.outputRouter = new OutputRouter(this.log, (zoneId, reason) => {
      this.playbackCoordinator.handlePlaybackError(zoneId, reason, 'output');
    }, this.audioManager);
    this.playbackCoordinator = new PlaybackCoordinator({
      zones: this.zoneRepo,
      queueController: this.queueController,
      outputRouter: this.outputRouter,
      applyPatch: (zoneId, patch, force) => this.applyPatch(zoneId, patch, force),
      stopAlert: (zoneId) => this.stopAlert(zoneId),
      log: this.log,
      notifier: notifierProxy,
      inputsPort: this.inputsPort,
      audioHelpers,
      contentPort: this.contentPort,
      configPort: this.configPort,
      recentsManager,
      audioManager: this.audioManager,
    });
    this.alertsCoordinator = new AlertsCoordinator({
      zones: this.zoneRepo,
      playbackCoordinator: this.playbackCoordinator,
      applyPatch: (zoneId, patch, force) => this.applyPatch(zoneId, patch, force),
      log: this.log,
      audioHelpers,
    });
  }

  public setNotifier(notifier: NotifierPort): void {
    this.notifier = notifier;
  }

  public getOutputHandlers(): OutputHandlers {
    return {
      onQueueUpdate: (zoneId, items, currentIndex) => {
        this.updateQueueFromOutput(zoneId, items, currentIndex);
      },
      onOutputError: (zoneId, reason) => {
        this.playbackCoordinator.handlePlaybackError(zoneId, reason, 'output');
      },
      onOutputState: (zoneId, state) => {
        this.playbackCoordinator.updateOutputState(zoneId, state);
      },
    };
  }

  private configureInputs(): void {
    if (this.inputsConfigured) {
      return;
    }
    const inputsPort = this.inputsPort;
    inputsPort.configureAirplay({
      startPlayback: (zoneId, label, source, metadata) => {
        this.playInputSource(zoneId, label, source, metadata);
      },
      updateMetadata: (zoneId, metadata) => {
        this.updateInputMetadata(zoneId, metadata);
      },
      updateCover: (zoneId, cover) => this.updateInputCover(zoneId, cover),
      updateVolume: (zoneId, volume) => this.updateInputVolume(zoneId, volume),
      updateTiming: (zoneId, elapsed, duration) => {
        this.updateInputTiming(zoneId, elapsed, duration);
      },
      pausePlayback: (zoneId) => this.pauseInputSource(zoneId),
      resumePlayback: (zoneId) => this.resumeInputSource(zoneId),
      stopPlayback: (zoneId) => {
        this.stopInputSource(zoneId);
      },
    });
    inputsPort.configureSpotify({
      startPlayback: (zoneId, label, source, metadata) => {
        const ctx = this.zoneRepo.get(zoneId);
        if (!ctx) {
          return;
        }
        // Ignore spotify input callbacks when another input is active (e.g. AirPlay).
        if (ctx.activeInput && ctx.activeInput !== 'spotify') {
          return;
        }
        ctx.spotifyAdapter.start(label, source, metadata);
      },
      updateMetadata: (zoneId, metadata) => {
        const ctx = this.zoneRepo.get(zoneId);
        if (!ctx || (ctx.activeInput && ctx.activeInput !== 'spotify')) {
          return;
        }
        ctx.spotifyAdapter.updateMetadata(metadata);
      },
      updateCover: (zoneId, cover) => {
        const ctx = this.zoneRepo.get(zoneId);
        if (!ctx || (ctx.activeInput && ctx.activeInput !== 'spotify')) {
          return;
        }
        return ctx.spotifyAdapter.updateCover(cover);
      },
      updateVolume: (zoneId, volume) => {
        const ctx = this.zoneRepo.get(zoneId);
        if (!ctx || (ctx.activeInput && ctx.activeInput !== 'spotify')) {
          return;
        }
        ctx.spotifyAdapter.updateVolume(volume);
      },
      updateTiming: (zoneId, elapsed, duration) => {
        const ctx = this.zoneRepo.get(zoneId);
        if (!ctx || (ctx.activeInput && ctx.activeInput !== 'spotify')) {
          return;
        }
        ctx.spotifyAdapter.updateTiming(elapsed, duration);
      },
      pausePlayback: (zoneId) => {
        const ctx = this.zoneRepo.get(zoneId);
        if (!ctx || (ctx.activeInput && ctx.activeInput !== 'spotify')) {
          return;
        }
        ctx.spotifyAdapter.pause();
      },
      resumePlayback: (zoneId) => {
        const ctx = this.zoneRepo.get(zoneId);
        if (!ctx || (ctx.activeInput && ctx.activeInput !== 'spotify')) {
          return;
        }
        ctx.spotifyAdapter.resume();
      },
      stopPlayback: (zoneId) => {
        const ctx = this.zoneRepo.get(zoneId);
        if (!ctx || (ctx.activeInput && ctx.activeInput !== 'spotify')) {
          return;
        }
        ctx.spotifyAdapter.stop();
      },
    });
    inputsPort.setAirplayPlayerResolver((zoneId: number) => this.zoneRepo.get(zoneId)?.player ?? null);
    this.inputsConfigured = true;
  }

  public async initialize(): Promise<void> {
    if (!this.initialized) {
      await this.configPort.load();
      const cfg = this.configPort.getConfig();
      await this.replaceAll(cfg.zones, cfg.inputs);
      this.startHeartbeat();
      this.initialized = true;
    }
  }

  public async replaceAll(zoneConfigs: ZoneConfig[], inputs?: InputConfig | null): Promise<void> {
    this.disposeAllOutputs();
    this.clearZoneContexts();
    clearPlayers();
    zoneConfigs.forEach((cfg) => this.registerZone(cfg));
    this.configureInputs();
    const inputsPort = this.inputsPort;
    inputsPort.syncAirplayZones(zoneConfigs, inputs?.airplay ?? null);
    inputsPort.syncSpotifyZones(zoneConfigs, inputs?.spotify ?? null);
    inputsPort.configureMusicAssistant(this.playbackCoordinator.getMusicAssistantInputHandlers());
    const contentPort = this.contentPort;
    contentPort.configureAppleMusic();
    contentPort.configureDeezer();
    contentPort.configureTidal();
    this.playbackCoordinator.refreshMusicAssistantProviderId();
    await inputsPort.syncMusicAssistantZones(zoneConfigs);
    const contexts = this.zoneRepo.list();
    this.log.info('zones registered', { count: contexts.length });
    // Broadcast initial states so clients get defaults (including volume).
    for (const ctx of contexts) {
      const volume = getZoneDefaultVolume(ctx.config);
      const patch = { ...ctx.state, volume };
      // Broadcast initial state using the same path as patches.
      this.applyPatch(ctx.id, patch, true);
      // Push default volume to outputs so they start at the configured level.
      this.outputRouter.dispatchVolume(ctx, ctx.outputs, volume);
    }
  }

  public async replaceZones(zoneConfigs: ZoneConfig[], inputs?: InputConfig | null): Promise<void> {
    if (!zoneConfigs || zoneConfigs.length === 0) {
      return;
    }

    // Tear down existing contexts for the affected zones.
    for (const cfg of zoneConfigs) {
      await this.disposeZone(cfg.id);
    }

    // Register the new/updated zones.
    zoneConfigs.forEach((cfg) => this.registerZone(cfg));

    // Refresh input services using the full current set.
    const allZones = this.zoneRepo.list().map((ctx) => ctx.config);
    this.configureInputs();
    const inputsPort = this.inputsPort;
    inputsPort.syncAirplayZones(allZones, inputs?.airplay ?? null);
    inputsPort.syncSpotifyZones(allZones, inputs?.spotify ?? null);
    inputsPort.configureMusicAssistant(this.playbackCoordinator.getMusicAssistantInputHandlers());
    const contentPort = this.contentPort;
    contentPort.configureAppleMusic();
    contentPort.configureDeezer();
    contentPort.configureTidal();
    this.playbackCoordinator.refreshMusicAssistantProviderId();
    await inputsPort.syncMusicAssistantZones(allZones);

    // Push initial state for the updated zones.
    for (const cfg of zoneConfigs) {
      const ctx = this.zoneRepo.get(cfg.id);
      if (!ctx) {
        continue;
      }
      const volume = getZoneDefaultVolume(ctx.config);
      const patch = { ...ctx.state, volume };
      this.applyPatch(ctx.id, patch, true);
      this.outputRouter.dispatchVolume(ctx, ctx.outputs, volume);
    }
  }

  private async disposeZone(zoneId: number): Promise<void> {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    try {
      const session = ctx.player.stop('reconfigure');
      await this.stopOutputs(ctx.outputs, session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('zone dispose failed', { zoneId, message });
    }
    unregisterPlayer(zoneId);
    this.zoneRepo.delete(zoneId);
  }

  public async shutdown(): Promise<void> {
    await Promise.all(
      this.zoneRepo.list().map(async (ctx) => {
        const session = ctx.player.stop('shutdown');
        await this.stopOutputs(ctx.outputs, session);
        unregisterPlayer(ctx.id);
      }),
    );
    this.disposeAllOutputs();
    await this.inputsPort.shutdownAirplay();
    await this.inputsPort.shutdownSpotify();
    this.inputsPort.shutdownMusicAssistant();
    this.clearZoneContexts();
    this.initialized = false;
  }

  public getState(zoneId: number): LoxoneZoneState | undefined {
    return this.stateStore.getState(zoneId);
  }

  public getQueue(zoneId: number, start: number, limit: number) {
    return this.queueController.getQueue(zoneId, start, limit);
  }

  public getZoneVolumes(zoneId: number): ZoneConfig['volumes'] | undefined {
    return this.zoneRepo.get(zoneId)?.config?.volumes;
  }

  public async playContent(
    zoneId: number,
    uri: string,
    type: string,
    metadata?: PlaybackMetadata,
    options?: { startAtSec?: number },
  ): Promise<void> {
    return this.playbackCoordinator.playContent(zoneId, uri, type, metadata, options);
  }

  public playInputSource(
    zoneId: number,
    label: string,
    playbackSource: PlaybackSource,
    metadata?: PlaybackMetadata,
  ): void {
    this.playbackCoordinator.playInputSource(zoneId, label, playbackSource, metadata);
  }

  public stopInputSource(zoneId: number): void {
    this.playbackCoordinator.stopInputSource(zoneId);
  }

  public pauseInputSource(zoneId: number): void {
    this.playbackCoordinator.pauseInputSource(zoneId);
  }

  public resumeInputSource(zoneId: number): void {
    this.playbackCoordinator.resumeInputSource(zoneId);
  }

  public updateInputMetadata(zoneId: number, metadata: Partial<PlaybackMetadata>): void {
    this.playbackCoordinator.updateInputMetadata(zoneId, metadata);
  }

  public updateRadioMetadata(zoneId: number, metadata: { title: string; artist: string }): void {
    this.playbackCoordinator.updateRadioMetadata(zoneId, metadata);
  }

  public updateInputCover(zoneId: number, cover?: CoverArtPayload): string | undefined {
    return this.playbackCoordinator.updateInputCover(zoneId, cover);
  }

  public updateInputVolume(zoneId: number, volume: number): void {
    this.playbackCoordinator.updateInputVolume(zoneId, volume);
  }

  public updateInputTiming(zoneId: number, elapsed: number, duration: number): void {
    this.playbackCoordinator.updateInputTiming(zoneId, elapsed, duration);
  }

  public renameZone(zoneId: number, name: string): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    const trimmed = name.trim();
    if (!trimmed || ctx.name === trimmed) {
      return;
    }
    ctx.name = trimmed;
    const patch: Partial<LoxoneZoneState> = { name: trimmed };
    const current = ctx.queueController.current();
    const sourceName = this.audioHelpers.resolveSourceName(
      ctx.state.audiotype ?? this.audioHelpers.getInputAudioType(ctx),
      ctx,
      current,
    );
    if (sourceName) {
      patch.sourceName = sourceName;
    }
    this.applyPatch(zoneId, patch);
    void this.inputsPort.renameAirplayZone(zoneId, trimmed);
    void this.inputsPort.renameSpotifyZone(zoneId, trimmed);
  }

  public seekInQueue(zoneId: number, target: string): boolean {
    return this.queueController.seekInQueue(zoneId, target);
  }

  public handleCommand(zoneId: number, command: string, payload?: string): void {
    this.playbackCoordinator.handleCommand(zoneId, command, payload);
  }

  public async startAlert(
    zoneId: number,
    type: string,
    media: AlertMediaResource,
    volume: number,
  ): Promise<void> {
    return this.alertsCoordinator.startAlert(zoneId, type, media, volume);
  }

  public async stopAlert(zoneId: number): Promise<void> {
    return this.alertsCoordinator.stopAlert(zoneId);
  }

  public applyPatch(zoneId: number, patch: Partial<LoxoneZoneState>, force = false): void {
    this.stateStore.patch(zoneId, patch, force);
  }

  public syncGroupMembersToLeader(leaderId: number): void {
    this.groupingCoordinator.syncGroupMembersToLeader(leaderId);
  }

  public getMetadata(zoneId: number): Record<string, unknown> | undefined {
    return this.stateStore.getMetadata(zoneId);
  }

  public getTechnicalSnapshot(zoneId: number): {
    inputMode: ZoneContext['inputMode'];
    activeInput: string | null;
    activeOutput: string | null;
    transports: string[];
    outputs: string[];
  } | null {
    return this.stateStore.getTechnicalSnapshot(zoneId);
  }

  public setShuffle(zoneId: number, enabled: boolean): void {
    this.queueController.setShuffle(zoneId, enabled);
  }

  public setPendingShuffle(zoneId: number, enabled: boolean): void {
    this.queueController.setPendingShuffle(zoneId, enabled);
  }

  public setRepeatMode(zoneId: number, mode: 'off' | 'one' | 'all'): void {
    this.queueController.setRepeatMode(zoneId, mode);
  }

  private registerZone(config: ZoneConfig): void {
    const outputs = this.outputsPort.listZoneOutputs(config.id);
    const requiresPcm = this.outputsRequirePcm(outputs);
    const player = new ZonePlayer(this.audioManager, config.id, config.name, config.sourceMac, requiresPcm);
    this.playbackCoordinator.setupPlayerListeners(player, outputs, config.id, config.name, config.sourceMac);
    const queue: QueueState = {
      items: [],
      shuffle: false,
      repeat: 0,
      currentIndex: 0,
      authority: 'local',
    };
    const queueController = new PlaybackQueueController(queue);
    registerPlayer(config.id, player);
    const inputAdapter = new InputAdapter({
      player,
      zoneName: config.name,
      sourceMac: config.sourceMac,
      replaceQueue: (items, startIndex = 0) => {
        queueController.setItems(items, startIndex);
        queue.shuffle = false;
        queue.repeat = 0;
        return queueController.current();
      },
      applyPatch: (patch) => this.applyPatch(config.id, patch),
      getDefaultSpotifyAccountId: () => this.contentPort.getDefaultSpotifyAccountId(),
    });
    const spotifyAdapter = new SpotifyInputAdapter(inputAdapter, {
      startPlayback: (_zoneId, label, source, metadata) =>
        this.playInputSource(config.id, label, source, metadata),
      updateMetadata: (zoneId, metadata) => this.updateInputMetadata(zoneId, metadata),
      updateCover: (zoneId, cover) => this.updateInputCover(zoneId, cover),
      updateVolume: (zoneId, volume) => this.updateInputVolume(zoneId, volume),
      updateTiming: (zoneId, elapsed, duration) =>
        this.updateInputTiming(zoneId, elapsed, duration),
      pausePlayback: (zoneId) => this.pauseInputSource(zoneId),
      resumePlayback: (zoneId) => this.resumeInputSource(zoneId),
      stopPlayback: (zoneId) => this.stopInputSource(zoneId),
    }, config.id);
    const context: ZoneContext = {
      id: config.id,
      name: config.name,
      sourceMac: config.sourceMac,
      config,
      state: buildInitialState(config),
      metadata: {},
      queue,
      queueController,
      inputAdapter,
      spotifyAdapter,
      outputs,
      player,
      outputTimingActive: false,
      lastOutputTimingAt: 0,
      lastZoneBroadcastAt: 0,
      lastPositionUpdateAt: 0,
      lastPositionValue: 0,
      lastMetadataDispatchAt: 0,
      activeOutputTypes: new Set(),
      activeOutput: null,
      activeInput: null,
      inputMode: null,
      alert: undefined,
    };
    this.zoneRepo.set(config.id, context);
    this.stateStore.setInitial(config.id, context.state);
  }

  private disposeAllOutputs(): void {
    this.outputRouter.disposeAllOutputs(this.zoneRepo);
  }

  private clearZoneContexts(): void {
    for (const ctx of this.zoneRepo.list()) {
      this.zoneRepo.delete(ctx.id);
    }
  }

  private notifyOutputMetadata(
    zoneId: number,
    ctx: ZoneContext,
    patch: Partial<LoxoneZoneState>,
  ): void {
    this.outputRouter.notifyOutputMetadata(zoneId, ctx, patch);
  }

  private updateQueueFromOutput(zoneId: number, items: QueueItem[], currentIndex: number): void {
    this.queueController.updateQueueFromOutput(zoneId, items, currentIndex);
  }

  private async stopOutputs(
    outputs: ZoneOutput[],
    session: PlaybackSession | null | undefined,
  ): Promise<void> {
    await this.outputRouter.stopOutputs(outputs, session);
  }

}
