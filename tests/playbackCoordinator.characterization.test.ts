import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from './testHarness';
import { PlaybackCoordinator } from '../src/application/zones/PlaybackCoordinator';
import { ZoneRepository } from '../src/application/zones/ZoneRepository';
import { QueueController as PlaybackQueueController } from '../src/application/playback/queueController';
import { buildInitialState } from '../src/application/zones/helpers/stateHelpers';
import { normalizeSpotifyAudiopath } from '../src/application/zones/helpers/queueHelpers';
import { applyZonePatch } from '../src/domain/loxone/reducer';
import { createZoneAudioHelpers } from '../src/application/zones/internal/zoneAudioHelpers';
import type { ZoneConfig, AudioServerConfig, RawAudioConfig } from '../src/domain/config/types';
import type { QueueItem } from '../src/ports/types/queueTypes';
import type { ZoneContext, QueueAuthority } from '../src/application/zones/internal/zoneTypes';
import type { InputsPort, InputStreamResult, LineInControlCommand } from '../src/ports/InputsPort';
import type { ContentPort } from '../src/ports/ContentPort';
import type { NotifierPort } from '../src/ports/NotifierPort';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { ZoneOutput } from '../src/ports/OutputsTypes';
import type { PlaybackMetadata, PlaybackSession, PlaybackSource, CoverArtPayload } from '../src/application/playback/audioManager';
import type { OutputRouter } from '../src/application/zones/OutputRouter';
import type { ZoneAudioHelpers } from '../src/application/zones/internal/zoneAudioHelpers';
import type { RecentsManager } from '../src/application/zones/recents/recentsManager';
import type { AudioManager } from '../src/application/playback/audioManager';
import type { ComponentLogger } from '../src/shared/logging/logger';

const baseConfig: AudioServerConfig = {
  system: {
    miniserver: { ip: '127.0.0.1', serial: 'miniserver' },
    audioserver: {
      ip: '127.0.0.1',
      name: 'audioserver',
      uuid: 'uuid',
      macId: '00:00:00:00:00:00',
      paired: false,
      extensions: [],
    },
    logging: { consoleLevel: 'info', fileLevel: 'info' },
    adminHttp: { enabled: true },
  },
  content: { radio: {}, spotify: { accounts: [], bridges: [] } },
  zones: [],
  rawAudioConfig: {} as RawAudioConfig,
};

class FakeConfigPort implements ConfigPort {
  private readonly config: AudioServerConfig;

  constructor(config: AudioServerConfig) {
    this.config = config;
  }

  public async load(): Promise<AudioServerConfig> {
    return this.config;
  }

  public getConfig(): AudioServerConfig {
    return this.config;
  }

  public getSystemConfig(): AudioServerConfig['system'] {
    return this.config.system;
  }

  public getRawAudioConfig(): RawAudioConfig {
    return this.config.rawAudioConfig;
  }

  public ensureInputs(): void {
    /* noop */
  }

  public async updateConfig(
    mutator: (config: AudioServerConfig) => void | Promise<void>,
  ): Promise<AudioServerConfig> {
    await mutator(this.config);
    return this.config;
  }
}

class FakeInputsPort implements InputsPort {
  public readonly stopSpotifyCalls: Array<{ zoneId: number; reason?: string }> = [];
  public readonly stopAirplayCalls: Array<{ zoneId: number; reason?: string }> = [];
  public readonly switchAwayCalls: number[] = [];
  public readonly remoteControlCalls: Array<{ zoneId: number; command: string }> = [];
  public readonly remoteVolumeCalls: Array<{ zoneId: number; volume: number }> = [];
  public readonly playerCommandCalls: Array<{ zoneId: number; command: string; args?: Record<string, unknown> }> = [];
  public readonly requestLineInStopCalls: string[] = [];
  public readonly requestLineInControlCalls: Array<{ inputId: string; command: LineInControlCommand }> = [];
  public readonly markSessionCalls: Array<{ zoneId: number; metadata?: PlaybackMetadata | null }> = [];
  public playbackSource: PlaybackSource | null = null;
  public streamResult: InputStreamResult = { playbackSource: null };

  public configureAirplay(): void {
    /* noop */
  }

  public setAirplayPlayerResolver(): void {
    /* noop */
  }

  public syncAirplayZones(): void {
    /* noop */
  }

  public async renameAirplayZone(): Promise<void> {
    /* noop */
  }

  public async shutdownAirplay(): Promise<void> {
    /* noop */
  }

  public configureSpotify(): void {
    /* noop */
  }

  public syncSpotifyZones(): void {
    /* noop */
  }

  public async renameSpotifyZone(): Promise<void> {
    /* noop */
  }

  public async shutdownSpotify(): Promise<void> {
    /* noop */
  }

  public configureMusicAssistant(): void {
    /* noop */
  }

  public async syncMusicAssistantZones(): Promise<void> {
    /* noop */
  }

  public shutdownMusicAssistant(): void {
    /* noop */
  }

  public getMusicAssistantProviderId(): string {
    return 'musicassistant';
  }

  public async startStreamForAudiopath(): Promise<InputStreamResult> {
    return this.streamResult;
  }

  public async getPlaybackSourceForUri(): Promise<PlaybackSource | null> {
    return this.playbackSource;
  }

  public getPlaybackSource(): PlaybackSource | null {
    return this.playbackSource;
  }

  public markSessionActive(zoneId: number, metadata?: PlaybackMetadata | null): void {
    this.markSessionCalls.push({ zoneId, metadata });
  }

  public stopAirplaySession(zoneId: number, reason?: string): void {
    this.stopAirplayCalls.push({ zoneId, reason });
  }

  public stopSpotifySession(zoneId: number, reason?: string): void {
    this.stopSpotifyCalls.push({ zoneId, reason });
  }

  public async switchAway(zoneId: number): Promise<void> {
    this.switchAwayCalls.push(zoneId);
  }

  public remoteControl(zoneId: number, command: string): void {
    this.remoteControlCalls.push({ zoneId, command });
  }

  public remoteVolume(zoneId: number, volumePercent: number): void {
    this.remoteVolumeCalls.push({ zoneId, volume: volumePercent });
  }

  public async playerCommand(
    zoneId: number,
    command: string,
    args?: Record<string, unknown>,
  ): Promise<boolean> {
    this.playerCommandCalls.push({ zoneId, command, args });
    return true;
  }

  public requestLineInStop(inputId: string): void {
    this.requestLineInStopCalls.push(inputId);
  }

  public requestLineInControl(inputId: string, command: LineInControlCommand): void {
    this.requestLineInControlCalls.push({ inputId, command });
  }
}

class FakeOutputRouter {
  public readonly queueStepCalls: Array<{ zoneId: number; delta: number }> = [];
  public readonly outputCalls: Array<{ zoneId: number; action: string; session: PlaybackSession | null | undefined }> = [];
  public readonly volumeCalls: Array<{ zoneId: number; volume: number }> = [];
  public shouldHandleQueueStep = false;
  public trace: string[] | null = null;

  public dispatchQueueStep(ctx: ZoneContext, _outputs: ZoneOutput[], delta: number): boolean {
    this.trace?.push('dispatchQueueStep');
    this.queueStepCalls.push({ zoneId: ctx.id, delta });
    return this.shouldHandleQueueStep;
  }

  public dispatchOutputs(
    ctx: ZoneContext,
    _outputs: ZoneOutput[],
    action: 'play' | 'pause' | 'resume' | 'stop',
    payload: PlaybackSession | null | undefined,
  ): void {
    this.trace?.push(`dispatchOutputs:${action}`);
    this.outputCalls.push({ zoneId: ctx.id, action, session: payload ?? null });
  }

  public dispatchVolume(ctx: ZoneContext, _outputs: ZoneOutput[], volume: number): void {
    this.trace?.push('dispatchVolume');
    this.volumeCalls.push({ zoneId: ctx.id, volume });
  }

  public selectPlayOutputs(outputs: ZoneOutput[]): ZoneOutput[] {
    return outputs;
  }
}

class FakeRecentsManager {
  public readonly records: Array<{ zoneId: number; item: QueueItem }> = [];

  public async record(zoneId: number, item: QueueItem): Promise<void> {
    this.records.push({ zoneId, item });
  }
}

class FakeAudioManager {
  public readonly preferred: Array<{ zoneId: number; settings: unknown }> = [];
  public readonly httpPrefs: Array<{ zoneId: number; prefs: unknown }> = [];
  public readonly inputPrefs: Array<{ zoneId: number; prefs: unknown }> = [];

  public setPreferredOutputSettings(zoneId: number, settings: unknown): void {
    this.preferred.push({ zoneId, settings });
  }

  public setHttpPreferences(zoneId: number, prefs: unknown): void {
    this.httpPrefs.push({ zoneId, prefs });
  }

  public setInputPreferences(zoneId: number, prefs: unknown): void {
    this.inputPrefs.push({ zoneId, prefs });
  }
}

class FakePlayer extends EventEmitter {
  public volume = 0;
  public timing = { elapsed: 0, duration: 0 };
  public metadata: PlaybackMetadata | null = null;
  public endGuardMs = 0;
  public state: { mode: 'playing' | 'paused' | 'stopped'; playbackSource: PlaybackSource | null } = {
    mode: 'stopped',
    playbackSource: null,
  };
  public session: PlaybackSession | null = null;
  public readonly stopReasons: string[] = [];

  private buildSession(source: string, playbackSource: PlaybackSource | null, metadata?: PlaybackMetadata): PlaybackSession {
    const now = Date.now();
    return {
      zoneId: 1,
      source,
      metadata,
      stream: {
        id: 'stream',
        url: 'http://example.com/stream',
        coverUrl: '',
        createdAt: now,
      },
      state: 'playing',
      elapsed: 0,
      duration: Math.round(metadata?.duration ?? 0),
      startedAt: now,
      updatedAt: now,
      playbackSource,
    };
  }

  public playUri(audiopath: string, metadata?: PlaybackMetadata): PlaybackSession {
    const session = this.buildSession(audiopath, null, metadata);
    this.session = session;
    this.state = { mode: 'playing', playbackSource: null };
    this.metadata = metadata ?? null;
    return session;
  }

  public playExternal(
    label: string,
    playbackSource: PlaybackSource | null,
    metadata?: PlaybackMetadata,
  ): PlaybackSession {
    const session = this.buildSession(label, playbackSource, metadata);
    this.session = session;
    this.state = { mode: 'playing', playbackSource };
    this.metadata = metadata ?? null;
    return session;
  }

  public pause(): PlaybackSession | null {
    if (this.session) {
      this.session.state = 'paused';
    }
    this.state.mode = 'paused';
    return this.session;
  }

  public resume(): PlaybackSession | null {
    if (this.session) {
      this.session.state = 'playing';
    }
    this.state.mode = 'playing';
    return this.session;
  }

  public stop(reason?: string): PlaybackSession | null {
    if (reason) {
      this.stopReasons.push(reason);
    }
    if (this.session) {
      this.session.state = 'stopped';
    }
    this.state.mode = 'stopped';
    return this.session;
  }

  public updateMetadata(metadata: PlaybackMetadata): void {
    this.metadata = { ...this.metadata, ...metadata };
    if (this.session) {
      this.session.metadata = this.metadata;
    }
  }

  public updateCover(cover?: CoverArtPayload): string | undefined {
    if (!cover) {
      return undefined;
    }
    if (this.session) {
      this.session.cover = cover;
    }
    return '/covers/zone.jpg';
  }

  public setVolume(level: number): void {
    this.volume = level;
  }

  public updateTiming(elapsed: number, duration: number): void {
    this.timing = { elapsed, duration };
  }

  public setEndGuardMs(ms: number): void {
    this.endGuardMs = ms;
  }

  public getState(): { mode: 'playing' | 'paused' | 'stopped'; playbackSource: PlaybackSource | null } {
    return this.state;
  }

  public getSession(): PlaybackSession | null {
    return this.session;
  }
}

class FakeQueueController {
  public readonly reorderCalls: Array<{ mode: 'shuffle' | 'unshuffle' }> = [];
  public readonly setShuffleCalls: Array<{ zoneId: number; enabled: boolean }> = [];

  public isLocalQueueAuthority(authority: QueueAuthority | undefined | null): boolean {
    return !authority || authority === 'local';
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
    ctx.queueController.setCurrentIndex(idx);
    return true;
  }

  public setShuffle(zoneId: number, enabled: boolean): void {
    this.setShuffleCalls.push({ zoneId, enabled });
  }

  public reorderQueue(_ctx: ZoneContext, mode: 'shuffle' | 'unshuffle'): void {
    this.reorderCalls.push({ mode });
  }

  public async fillQueueInBackground(): Promise<void> {
    /* noop */
  }

  public async buildQueueForUri(): Promise<QueueItem[]> {
    return [];
  }
}

const noopContentPort: ContentPort = {
  getDefaultSpotifyAccountId: () => null,
  resolveMetadata: async () => null,
  resolvePlaybackSource: async () => ({ playbackSource: null, provider: 'library' }),
  configureAppleMusic: () => {},
  configureDeezer: () => {},
  configureTidal: () => {},
  isAppleMusicProvider: () => false,
  isDeezerProvider: () => false,
  isTidalProvider: () => false,
  getMediaFolder: async () => null,
  getServiceTrack: async () => null,
  getServiceFolder: async () => null,
  buildQueueForUri: async () => [],
};

const noopNotifier: NotifierPort = {
  notifyZoneStateChanged: () => {},
  notifyQueueUpdated: () => {},
  notifyRoomFavoritesChanged: () => {},
  notifyRecentlyPlayedChanged: () => {},
  notifyRescan: () => {},
  notifyReloadMusicApp: () => {},
  notifyAudioSyncEvent: () => {},
};

function makeNotifierTracker(): {
  notifier: NotifierPort;
  queueUpdated: Array<{ zoneId: number; queueSize: number }>;
} {
  const queueUpdated: Array<{ zoneId: number; queueSize: number }> = [];
  return {
    notifier: {
      notifyZoneStateChanged: () => {},
      notifyQueueUpdated: (zoneId, queueSize) => {
        queueUpdated.push({ zoneId, queueSize });
      },
      notifyRoomFavoritesChanged: () => {},
      notifyRecentlyPlayedChanged: () => {},
      notifyRescan: () => {},
      notifyReloadMusicApp: () => {},
      notifyAudioSyncEvent: () => {},
    },
    queueUpdated,
  };
}

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  spam: () => {},
  isEnabled: () => false,
} as unknown as ComponentLogger;

function makeZoneConfig(id: number, name: string): ZoneConfig {
  return {
    id,
    name,
    sourceMac: `00:11:22:33:44:${String(id).padStart(2, '0')}`,
    transports: [],
    volumes: {
      default: 30,
      alarm: 50,
      fire: 50,
      bell: 50,
      buzzer: 50,
      tts: 50,
      volstep: 2,
      fading: 0,
      maxVolume: 100,
    },
    inputs: {
      airplay: { enabled: false },
      spotify: { enabled: false },
      musicassistant: { enabled: false },
      lineIn: { enabled: false },
    },
  };
}

let queueItemCounter = 0;
function makeQueueItem(overrides: Partial<QueueItem>): QueueItem {
  queueItemCounter += 1;
  return {
    album: '',
    artist: '',
    audiopath: '',
    audiotype: 0,
    coverurl: '',
    duration: 0,
    qindex: 0,
    station: '',
    title: '',
    unique_id: `queue-${queueItemCounter}`,
    user: 'nouser',
    ...overrides,
  };
}

function makeOutput(type: string, stopCalls: Array<PlaybackSession | null>): ZoneOutput {
  return {
    type,
    play: () => {},
    pause: () => {},
    resume: () => {},
    stop: (session) => {
      stopCalls.push(session ?? null);
    },
    dispose: () => {},
  };
}

function createHarness(options?: {
  notifier?: NotifierPort;
  contentPort?: ContentPort;
  trace?: string[];
}) {
  const zoneRepo = new ZoneRepository();
  const inputsPort = new FakeInputsPort();
  const outputRouter = new FakeOutputRouter();
  if (options?.trace) {
    outputRouter.trace = options.trace;
  }
  const queueController = new FakeQueueController();
  const recentsManager = new FakeRecentsManager();
  const audioManager = new FakeAudioManager();
  const configPort = new FakeConfigPort(baseConfig);
  const contentPort = options?.contentPort ?? noopContentPort;
  const audioHelpers: ZoneAudioHelpers = createZoneAudioHelpers(contentPort, configPort);
  const notifier = options?.notifier ?? noopNotifier;

  const patches: Array<{ zoneId: number; patch: Record<string, unknown> }> = [];
  const applyPatch = (zoneId: number, patch: Record<string, unknown>): void => {
    if (options?.trace) {
      options.trace.push('applyPatch');
    }
    patches.push({ zoneId, patch });
    const ctx = zoneRepo.get(zoneId);
    if (ctx) {
      ctx.state = applyZonePatch(ctx.state, patch as any);
    }
  };

  const stopAlert = async () => {};

  const config = makeZoneConfig(1, 'Zone');
  const queue = {
    items: [],
    shuffle: false,
    repeat: 0,
    currentIndex: 0,
    authority: 'local' as QueueAuthority,
  };
  const playbackQueue = new PlaybackQueueController(queue);
  const player = new FakePlayer();
  const stopCalls: Array<PlaybackSession | null> = [];
  const outputs: ZoneOutput[] = [
    makeOutput('spotify', stopCalls),
    makeOutput('local', stopCalls),
  ];

  const ctx: ZoneContext = {
    id: config.id,
    name: config.name,
    sourceMac: config.sourceMac,
    config,
    state: buildInitialState(config),
    metadata: {},
    queue,
    queueController: playbackQueue,
    inputAdapter: { playInput: () => {} } as any,
    spotifyAdapter: {} as any,
    outputs,
    player: player as any,
    outputTimingActive: false,
    lastOutputTimingAt: 0,
    lastZoneBroadcastAt: 0,
    lastPositionUpdateAt: 0,
    lastPositionValue: 0,
    activeOutputTypes: new Set(),
    activeOutput: null,
    activeInput: null,
    lastMetadataDispatchAt: 0,
    inputMode: null,
    alert: undefined,
  };

  zoneRepo.set(ctx.id, ctx);

  const coordinator = new PlaybackCoordinator({
    zones: zoneRepo,
    queueController: queueController as unknown as any,
    outputRouter: outputRouter as unknown as OutputRouter,
    applyPatch: (zoneId, patch, _force) => applyPatch(zoneId, patch as any),
    stopAlert,
    log: noopLogger,
    notifier,
    inputsPort: inputsPort as unknown as InputsPort,
    audioHelpers,
    contentPort,
    configPort,
    recentsManager: recentsManager as unknown as RecentsManager,
    audioManager: audioManager as unknown as AudioManager,
  });

  return {
    coordinator,
    ctx,
    patches,
    inputsPort,
    outputRouter,
    recentsManager,
    stopCalls,
    playbackQueue,
    notifier,
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test('input switching gates callbacks and stops prior sessions', async () => {
  const { coordinator, ctx, patches, inputsPort, stopCalls } = createHarness();
  const source: PlaybackSource = { kind: 'url', url: 'http://spotify.local/stream' };

  coordinator.playInputSource(ctx.id, 'spotify', source, {
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    audiopath: 'spotify:track:one',
  });

  const handlers = coordinator.getMusicAssistantInputHandlers();
  handlers.updateMetadata?.(ctx.id, { title: 'Ignored' });
  assert.equal(patches.length, 0);

  await coordinator.startQueuePlayback(ctx, 'tunein:station:abc', {
    title: 'Station',
    artist: '',
    album: '',
    audiopath: 'tunein:station:abc',
  });

  assert.equal(inputsPort.stopSpotifyCalls.length, 1);
  assert.equal(inputsPort.stopSpotifyCalls[0]?.reason, 'switch_to_queue');
  assert.equal(stopCalls.length, 1);

  coordinator.updateInputMetadata(ctx.id, { title: 'Stale update' });
  assert.equal(patches.length, 0);

  coordinator.playInputSource(ctx.id, 'musicassistant', source, {
    title: 'MA Track',
    artist: 'MA',
    album: 'MA',
    audiopath: 'musicassistant://track/1',
  });

  handlers.updateMetadata?.(ctx.id, { title: 'Now Playing', artist: 'MA' });
  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.patch.title, 'Now Playing');
});

test('queue next/prev advances qindex and qid', async () => {
  const { coordinator, ctx, patches, playbackQueue } = createHarness();
  const items = [
    makeQueueItem({ title: 'One', audiopath: 'library://track/one', unique_id: 'id-1' }),
    makeQueueItem({ title: 'Two', audiopath: 'library://track/two', unique_id: 'id-2' }),
    makeQueueItem({ title: 'Three', audiopath: 'library://track/three', unique_id: 'id-3' }),
  ];
  playbackQueue.setItems(items, 0);
  ctx.queue.authority = 'local';
  ctx.inputMode = 'queue';

  coordinator.handleCommand(ctx.id, 'queueplus');
  await flushAsync();

  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.patch.qindex, 1);
  assert.equal(patches[0]?.patch.qid, 'id-2');
  assert.equal(patches[0]?.patch.queueAuthority, 'local');

  patches.length = 0;
  coordinator.handleCommand(ctx.id, 'queueminus');
  await flushAsync();

  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.patch.qindex, 0);
  assert.equal(patches[0]?.patch.qid, 'id-1');
});

test('music assistant metadata seek updates qindex/qid', () => {
  const { coordinator, ctx, patches, playbackQueue } = createHarness();
  const items = [
    makeQueueItem({ title: 'One', audiopath: 'musicassistant://track/one', unique_id: 'id-1' }),
    makeQueueItem({ title: 'Two', audiopath: 'musicassistant://track/two', unique_id: 'id-2' }),
  ];
  playbackQueue.setItems(items, 0);
  ctx.queue.authority = 'musicassistant';
  ctx.inputMode = 'musicassistant';

  coordinator.updateInputMetadata(ctx.id, {
    title: 'Two',
    artist: 'Artist',
    album: 'Album',
    audiopath: 'musicassistant://track/two',
  });

  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.patch.qindex, 1);
  assert.equal(patches[0]?.patch.qid, 'id-2');
  assert.equal(patches[0]?.patch.queueAuthority, 'musicassistant');
});

test('stop command for music assistant stops output and session', () => {
  const { coordinator, ctx, inputsPort, outputRouter } = createHarness();
  ctx.inputMode = 'musicassistant';
  ctx.activeInput = 'musicassistant';

  coordinator.handleCommand(ctx.id, 'stop');

  assert.equal(inputsPort.playerCommandCalls.length, 1);
  assert.equal(inputsPort.playerCommandCalls[0]?.command, 'stop');
  assert.equal(outputRouter.outputCalls.length, 1);
  assert.equal(outputRouter.outputCalls[0]?.action, 'stop');
  assert.equal(ctx.inputMode, null);
});

test('metadata update patches cover/title/artist/album/duration/audiopath', () => {
  const { coordinator, ctx, patches, playbackQueue, recentsManager } = createHarness();
  const item = makeQueueItem({
    title: '',
    artist: '',
    album: '',
    coverurl: '',
    audiopath: 'spotify:track:one',
    duration: 200,
    unique_id: 'id-1',
  });
  playbackQueue.setItems([item], 0);
  ctx.state.icontype = 7 as any;
  ctx.queue.authority = 'spotify';

  coordinator.updateInputMetadata(ctx.id, {
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    coverurl: 'http://covers/1.jpg',
    duration: 120,
    audiopath: 'spotify:track:one',
  });

  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.patch.title, 'Song');
  assert.equal(patches[0]?.patch.artist, 'Artist');
  assert.equal(patches[0]?.patch.album, 'Album');
  assert.equal(patches[0]?.patch.coverurl, 'http://covers/1.jpg');
  assert.equal(patches[0]?.patch.audiopath, 'spotify:track:one');
  assert.equal(patches[0]?.patch.duration, 120);
  assert.equal(patches[0]?.patch.audiotype, 1);
  assert.equal(patches[0]?.patch.icontype, undefined);
  assert.equal(patches[0]?.patch.queueAuthority, 'spotify');
  assert.equal(recentsManager.records.length, 1);
});

test('volume_set applies step, patches volume, and notifies inputs/outputs', () => {
  const { coordinator, ctx, patches, inputsPort, outputRouter } = createHarness();
  ctx.inputMode = 'musicassistant';

  coordinator.handleCommand(ctx.id, 'volume_set', '33');

  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.patch.volume, 34);
  assert.equal(inputsPort.playerCommandCalls.length, 1);
  assert.equal(inputsPort.playerCommandCalls[0]?.command, 'volume_set');
  assert.equal((inputsPort.playerCommandCalls[0]?.args ?? {}).volume_level, 34);
  assert.equal(outputRouter.volumeCalls.length, 1);
  assert.equal(outputRouter.volumeCalls[0]?.volume, 34);
});

test('volume command rounds relative steps and forwards airplay volume', () => {
  const { coordinator, ctx, patches, inputsPort } = createHarness();
  ctx.inputMode = 'airplay';
  ctx.state.volume = 30;

  coordinator.handleCommand(ctx.id, 'volume', '+3');

  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.patch.volume, 34);
  assert.equal(inputsPort.remoteVolumeCalls.length, 1);
  assert.equal(inputsPort.remoteVolumeCalls[0]?.volume, 34);

  patches.length = 0;
  ctx.state.volume = 30;
  coordinator.handleCommand(ctx.id, 'volume', '-3');

  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.patch.volume, 26);
});

test('queueplus fallback only steps queue when output does not handle it', () => {
  const { coordinator, ctx, outputRouter } = createHarness();
  ctx.inputMode = 'queue';
  ctx.queue.authority = 'local';
  let stepCalled = false;
  (coordinator as any).stepQueue = () => {
    stepCalled = true;
  };

  outputRouter.shouldHandleQueueStep = true;
  coordinator.handleCommand(ctx.id, 'queueplus');
  assert.equal(stepCalled, false);

  outputRouter.shouldHandleQueueStep = false;
  coordinator.handleCommand(ctx.id, 'queueplus');
  assert.equal(stepCalled, true);
});

test('position command forwards seek to music assistant without dispatching outputs', () => {
  const { coordinator, ctx, inputsPort, outputRouter } = createHarness();
  ctx.inputMode = 'musicassistant';

  coordinator.handleCommand(ctx.id, 'position', '12');

  assert.equal(inputsPort.playerCommandCalls.length, 1);
  assert.equal(inputsPort.playerCommandCalls[0]?.command, 'seek');
  assert.deepEqual(inputsPort.playerCommandCalls[0]?.args, { position: 12 });
  assert.equal(outputRouter.outputCalls.length, 0);
});

test('shuffle and repeat parsing preserves existing behavior', () => {
  const { coordinator, ctx } = createHarness();
  const queueController = (coordinator as any).queueController as FakeQueueController;

  ctx.queue.shuffle = false;
  coordinator.handleCommand(ctx.id, 'shuffle', 'on');
  assert.equal(queueController.setShuffleCalls.length, 1);
  assert.equal(queueController.setShuffleCalls[0]?.enabled, true);

  coordinator.handleCommand(ctx.id, 'shuffle', 'off');
  assert.equal(queueController.setShuffleCalls.length, 2);
  assert.equal(queueController.setShuffleCalls[1]?.enabled, false);

  ctx.queue.shuffle = false;
  coordinator.handleCommand(ctx.id, 'shuffle', 'invalid');
  assert.equal(queueController.setShuffleCalls.length, 3);
  assert.equal(queueController.setShuffleCalls[2]?.enabled, true);

  coordinator.handleCommand(ctx.id, 'repeat', 'off');
  assert.equal(ctx.queue.repeat, 0);

  ctx.queue.repeat = 0;
  coordinator.handleCommand(ctx.id, 'repeat');
  assert.equal(ctx.queue.repeat, 1);
});

test('playContent seek fast-path starts current item and notifies queue', async () => {
  const notifierTracker = makeNotifierTracker();
  const { coordinator, ctx, playbackQueue, recentsManager } = createHarness({
    notifier: notifierTracker.notifier,
  });
  const items = [
    makeQueueItem({ title: 'One', audiopath: 'library://track/one', unique_id: 'id-1' }),
    makeQueueItem({ title: 'Two', audiopath: 'library://track/two', unique_id: 'id-2' }),
  ];
  playbackQueue.setItems(items, 0);
  ctx.state.mode = 'play';
  let startedAudiopath: string | null = null;
  (coordinator as any).startQueuePlayback = async (_ctx: ZoneContext, audiopath: string) => {
    startedAudiopath = audiopath;
    return {} as PlaybackSession;
  };

  await coordinator.playContent(ctx.id, 'library://track/two', 'track', { title: 'Two', artist: '', album: '' });

  assert.equal(startedAudiopath, 'library://track/two');
  assert.equal(recentsManager.records.length, 1);
  assert.equal(notifierTracker.queueUpdated.length, 1);
  assert.equal(notifierTracker.queueUpdated[0]?.queueSize, ctx.queue.items.length);
});

test('playContent rebuild path starts playback and records recents', async () => {
  const notifierTracker = makeNotifierTracker();
  const { coordinator, ctx, recentsManager } = createHarness({
    notifier: notifierTracker.notifier,
  });
  ctx.state.mode = 'stop';
  let startedAudiopath: string | null = null;
  (coordinator as any).startQueuePlayback = async (_ctx: ZoneContext, audiopath: string) => {
    startedAudiopath = audiopath;
    return {} as PlaybackSession;
  };

  await coordinator.playContent(ctx.id, 'library://track/one', 'track', { title: 'One', artist: '', album: '' });

  assert.equal(startedAudiopath, ctx.queueController.current()?.audiopath ?? null);
  assert.equal(recentsManager.records.length, 1);
  assert.equal(notifierTracker.queueUpdated.length, 1);
});

test('playContent unplayable path stops outputs and applies stop patch', async () => {
  const { coordinator, ctx, patches, outputRouter } = createHarness();
  ctx.state.mode = 'stop';
  (coordinator as any).startQueuePlayback = async () => null;

  await coordinator.playContent(ctx.id, 'spotify:track:one', 'track', { title: 'One', artist: '', album: '' });

  const lastPatch = patches[patches.length - 1]?.patch ?? {};
  assert.equal((lastPatch as any).mode, 'stop');
  assert.equal((lastPatch as any).clientState, 'on');
  assert.equal((lastPatch as any).power, 'on');
  assert.equal(outputRouter.outputCalls.length, 1);
  assert.equal(outputRouter.outputCalls[0]?.action, 'stop');
});

test('playContent ignores MA serviceplay when already playing target', async () => {
  const { coordinator, ctx, inputsPort, outputRouter } = createHarness();
  const items = [
    makeQueueItem({ title: 'One', audiopath: 'musicassistant://track/one', unique_id: 'id-1' }),
  ];
  ctx.queueController.setItems(items, 0);
  ctx.state.mode = 'play';
  ctx.inputMode = 'musicassistant';
  ctx.activeInput = 'musicassistant';
  let started = false;
  (coordinator as any).startQueuePlayback = async () => {
    started = true;
    return {} as PlaybackSession;
  };

  await coordinator.playContent(ctx.id, 'musicassistant://track/one', 'serviceplay');

  assert.equal(started, false);
  assert.equal(inputsPort.stopSpotifyCalls.length, 0);
  assert.equal(inputsPort.stopAirplayCalls.length, 0);
  assert.equal(outputRouter.outputCalls.length, 0);
});

test('player started dispatches outputs, volume, and patch in order', () => {
  const trace: string[] = [];
  const { coordinator, ctx, patches } = createHarness({ trace });
  coordinator.setupPlayerListeners(ctx.player as any, ctx.outputs, ctx.id, ctx.name, ctx.sourceMac);
  ctx.state.volume = 42;
  ctx.queueController.setItems([makeQueueItem({ title: 'Track', audiopath: 'library://one', unique_id: 'id-1' })], 0);
  const session = {
    metadata: { title: 'Track', artist: 'Artist', album: 'Album', audiopath: 'library://one', duration: 120 },
  } as PlaybackSession;

  const player = ctx.player as unknown as EventEmitter;
  player.emit('started', session);

  assert.deepEqual(trace, ['dispatchOutputs:play', 'dispatchVolume', 'applyPatch']);
  assert.equal(patches.length, 1);
  assert.equal((patches[0]?.patch as any).mode, 'play');
  assert.equal((patches[0]?.patch as any).queueAuthority, 'local');
});

test('player resumed dispatches outputs before patch', () => {
  const trace: string[] = [];
  const { coordinator, ctx, patches } = createHarness({ trace });
  coordinator.setupPlayerListeners(ctx.player as any, ctx.outputs, ctx.id, ctx.name, ctx.sourceMac);

  const player = ctx.player as unknown as EventEmitter;
  player.emit('resumed', null);

  assert.deepEqual(trace, ['dispatchOutputs:resume', 'applyPatch']);
  assert.equal(patches.length, 1);
  assert.equal((patches[0]?.patch as any).mode, 'play');
});

test('player paused dispatches outputs before patch', () => {
  const trace: string[] = [];
  const { coordinator, ctx, patches } = createHarness({ trace });
  coordinator.setupPlayerListeners(ctx.player as any, ctx.outputs, ctx.id, ctx.name, ctx.sourceMac);

  const player = ctx.player as unknown as EventEmitter;
  player.emit('paused', null);

  assert.deepEqual(trace, ['dispatchOutputs:pause', 'applyPatch']);
  assert.equal(patches.length, 1);
  assert.equal((patches[0]?.patch as any).mode, 'pause');
});

test('player stopped dispatches outputs before patch', () => {
  const trace: string[] = [];
  const { coordinator, ctx, patches } = createHarness({ trace });
  coordinator.setupPlayerListeners(ctx.player as any, ctx.outputs, ctx.id, ctx.name, ctx.sourceMac);

  const player = ctx.player as unknown as EventEmitter;
  player.emit('stopped', null);

  assert.deepEqual(trace, ['dispatchOutputs:stop', 'applyPatch']);
  assert.equal(patches.length, 1);
  assert.equal((patches[0]?.patch as any).mode, 'stop');
});

test('player position forces radio time/duration to zero', () => {
  const { coordinator, ctx, patches } = createHarness();
  coordinator.setupPlayerListeners(ctx.player as any, ctx.outputs, ctx.id, ctx.name, ctx.sourceMac);
  ctx.state.audiopath = 'tunein:station:abc';
  ctx.state.audiotype = 1 as any;
  ctx.state.time = 5;
  ctx.state.duration = 10;

  const player = ctx.player as unknown as EventEmitter;
  player.emit('position', 12, 34);

  assert.equal(patches.length, 1);
  assert.equal((patches[0]?.patch as any).time, 0);
  assert.equal((patches[0]?.patch as any).duration, 0);
});

test('player position throttles identical updates', () => {
  const { coordinator, ctx, patches } = createHarness();
  coordinator.setupPlayerListeners(ctx.player as any, ctx.outputs, ctx.id, ctx.name, ctx.sourceMac);
  ctx.state.audiopath = 'library://track/one';
  ctx.state.duration = 100;
  const now = Date.now();
  ctx.lastPositionUpdateAt = now;
  ctx.lastPositionValue = 10;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const player = ctx.player as unknown as EventEmitter;
    player.emit('position', 10, 100);
  } finally {
    Date.now = originalNow;
  }

  assert.equal(patches.length, 0);
});

test('handleEndOfTrack stops when queue ends', async () => {
  const { coordinator, ctx, outputRouter } = createHarness();
  ctx.queueController.setItems([makeQueueItem({ audiopath: 'library://one', unique_id: 'id-1' })], 0);
  ctx.queue.authority = 'local';
  ctx.queue.repeat = 0;
  ctx.queue.shuffle = false;

  await (coordinator as any).handleEndOfTrack(ctx);

  const player = ctx.player as unknown as FakePlayer;
  assert.equal(player.stopReasons.includes('queue_end'), true);
  assert.equal(outputRouter.outputCalls.length, 1);
  assert.equal(outputRouter.outputCalls[0]?.action, 'stop');
});

test('handleEndOfTrack stops on invalid next item', async () => {
  const { coordinator, ctx, outputRouter } = createHarness();
  ctx.queueController.setItems(
    [
      makeQueueItem({ audiopath: 'library://one', unique_id: 'id-1' }),
      makeQueueItem({ audiopath: 'library://two', unique_id: 'id-2' }),
    ],
    0,
  );
  ctx.queue.authority = 'local';
  (ctx.queueController as any).current = () => null;

  await (coordinator as any).handleEndOfTrack(ctx);

  const player = ctx.player as unknown as FakePlayer;
  assert.equal(player.stopReasons.includes('queue_invalid_next'), true);
  assert.equal(outputRouter.outputCalls.length, 1);
  assert.equal(outputRouter.outputCalls[0]?.action, 'stop');
});

test('handleEndOfTrack stops when next track fails to start', async () => {
  const { coordinator, ctx, outputRouter } = createHarness();
  ctx.queueController.setItems(
    [
      makeQueueItem({ audiopath: 'library://one', unique_id: 'id-1' }),
      makeQueueItem({ audiopath: 'library://two', unique_id: 'id-2' }),
    ],
    0,
  );
  ctx.queue.authority = 'local';
  (coordinator as any).startQueuePlayback = async () => null;

  await (coordinator as any).handleEndOfTrack(ctx);

  const player = ctx.player as unknown as FakePlayer;
  assert.equal(player.stopReasons.includes('queue_next_failed'), true);
  assert.equal(outputRouter.outputCalls.length, 1);
  assert.equal(outputRouter.outputCalls[0]?.action, 'stop');
});

test('startQueuePlayback transitions input and stops external sessions once', async () => {
  const { coordinator, ctx, inputsPort, stopCalls } = createHarness();
  ctx.inputMode = 'spotify';
  ctx.activeInput = 'spotify';

  await coordinator.startQueuePlayback(ctx, 'library://track/one', {
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    audiopath: 'library://track/one',
  });

  assert.equal(ctx.inputMode, 'queue');
  assert.equal(ctx.activeInput, 'queue');
  assert.equal(inputsPort.stopSpotifyCalls.length, 1);
  assert.equal(inputsPort.stopSpotifyCalls[0]?.reason, 'switch_to_queue');
  assert.equal(stopCalls.length, 1);
});

test('playContent does not double-stop external sessions', async () => {
  const { coordinator, ctx, inputsPort } = createHarness();
  ctx.inputMode = 'spotify';
  ctx.activeInput = 'spotify';

  await coordinator.playContent(ctx.id, 'library://track/one', 'track', {
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
  });

  assert.equal(inputsPort.stopSpotifyCalls.length, 1);
});
