import 'tsconfig-paths/register';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, tests } from './testHarness';
import './architecture/importBoundaries.test';
import './playbackRefactorSeams.test';
import './playbackCoordinator.characterization.test';
import './adminApiJsonBody.test';
import './airplayPcmStream.test';
import './runtimeShutdown.test';
import type { ZoneConfig } from '../src/domain/config/types';
import { applyZonePatch } from '../src/domain/loxone/reducer';
import type { LoxoneZoneState } from '../src/domain/loxone/types';
import type { QueueItem } from '../src/ports/types/queueTypes';
import type { PlaybackSession } from '../src/application/playback/audioManager';
import { StorageAdapter } from '../src/adapters/storage/StorageAdapter';
import type { AirplayGroupCoordinator } from '../src/application/outputs/airplayGroupController';
import { makeOutputPortsFake, noopAirplayGroupController } from './fakes/outputPorts';
import type { ContentPort } from '../src/ports/ContentPort';
import type { NotifierPort } from '../src/ports/NotifierPort';
import { makeNotifierFake } from './fakes/notifierPort';
import { makePlaybackServiceFake } from './fakes/playbackService';
import type { ZoneManagerFacade } from '../src/application/zones/createZoneManager';
import { createRecentsManager } from '../src/application/zones/recents/recentsManager';
import type { GroupManager } from '../src/application/groups/groupManager';

type ZoneHarness = {
  tempDir: string;
  zoneManager: ZoneManagerFacade;
  updateQueueFromOutput: (zoneId: number, items: QueueItem[], currentIndex: number) => void;
  setNotifier: (notifier: NotifierPort) => void;
  noopNotifier: NotifierPort;
  airplayGroupController: AirplayGroupCoordinator;
  noopAirplayGroupController: AirplayGroupCoordinator;
  groupManager: GroupManager;
  groupTracker: typeof import('../src/application/groups/groupTracker');
  cleanup: () => Promise<void>;
};

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

let zoneHarnessPromise: Promise<ZoneHarness> | null = null;
const noopNotifier = makeNotifierFake();

function purgeModule(modulePath: string): void {
  const resolved = require.resolve(modulePath, { paths: [__dirname] });
  delete require.cache[resolved];
}

function freshRequire<T>(modulePath: string): T {
  purgeModule(modulePath);
  return require(modulePath) as T;
}

async function createZoneHarness(): Promise<ZoneHarness> {
  const originalCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lox-audioserver-tests-'));
  process.chdir(tempDir);
  try {
    purgeModule('../src/application/config/configRepository');
    purgeModule('../src/application/playback/audioManager');
    purgeModule('../src/application/zones/zoneManager');
    purgeModule('../src/application/zones/createZoneManager');
    purgeModule('../src/application/groups/groupManager');
    purgeModule('../src/application/groups/groupTracker');
    purgeModule('../src/adapters/inputs/InputsAdapter');
    purgeModule('../src/adapters/inputs/spotify/spotifyInputService');
    purgeModule('../src/adapters/inputs/musicassistant/musicAssistantStreamService');
    purgeModule('../src/adapters/inputs/linein/lineInMetadataService');
    purgeModule('../src/adapters/inputs/linein/sendspinLineInService');
    purgeModule('../src/adapters/loxone/services/loxoneConfigService');
    purgeModule('../src/adapters/outputs/OutputsAdapter');

    const configRepositoryModule = require('../src/application/config/configRepository') as typeof import('../src/application/config/configRepository');
    const configAdapterModule = require('../src/adapters/config/ConfigAdapter') as typeof import('../src/adapters/config/ConfigAdapter');
    const storage = new StorageAdapter();
    const configRepository = new configRepositoryModule.ConfigRepository(storage);
    const configPort = new configAdapterModule.ConfigAdapter(configRepository);
    await configPort.load();
    const spotifyManagerModule = require('../src/adapters/content/providers/spotifyServiceManager') as typeof import('../src/adapters/content/providers/spotifyServiceManager');
    const spotifyManagerProvider = new spotifyManagerModule.SpotifyServiceManagerProvider(configPort);
    const spotifyDeviceRegistryModule = require('../src/adapters/outputs/spotify/deviceRegistry') as typeof import('../src/adapters/outputs/spotify/deviceRegistry');
    const spotifyDeviceRegistry = new spotifyDeviceRegistryModule.SpotifyDeviceRegistry();

    let outputHandlers: ReturnType<ZoneManagerFacade['getOutputHandlers']> | null = null;
    const requireOutputHandlers = (): ReturnType<ZoneManagerFacade['getOutputHandlers']> => {
      if (!outputHandlers) {
        throw new Error('output handlers not configured');
      }
      return outputHandlers;
    };
    const outputHandlersProxy: ReturnType<ZoneManagerFacade['getOutputHandlers']> = {
      onQueueUpdate: (zoneId, items, currentIndex) => {
        requireOutputHandlers().onQueueUpdate(zoneId, items, currentIndex);
      },
      onOutputError: (zoneId, reason) => {
        requireOutputHandlers().onOutputError(zoneId, reason);
      },
      onOutputState: (zoneId, state) => {
        requireOutputHandlers().onOutputState(zoneId, state);
      },
    };
    const outputNotifier = {
      notifyOutputError: outputHandlersProxy.onOutputError,
      notifyOutputState: outputHandlersProxy.onOutputState,
    };
    const { AudioManager } = require('../src/application/playback/audioManager') as typeof import('../src/application/playback/audioManager');
    const audioManager = new AudioManager(makePlaybackServiceFake(), outputNotifier);

    const lineInRegistryModule = require('../src/adapters/inputs/linein/lineInIngestRegistry') as typeof import('../src/adapters/inputs/linein/lineInIngestRegistry');
    const lineInRegistry = new lineInRegistryModule.LineInIngestRegistry();

    const musicAssistantStreamServiceModule = require('../src/adapters/inputs/musicassistant/musicAssistantStreamService') as typeof import('../src/adapters/inputs/musicassistant/musicAssistantStreamService');
    const musicAssistantStreamService = new musicAssistantStreamServiceModule.MusicAssistantStreamService(
      outputHandlersProxy,
      configPort,
    );
    const musicAssistantInputServiceModule = require('../src/adapters/inputs/musicassistant/musicAssistantInputService') as typeof import('../src/adapters/inputs/musicassistant/musicAssistantInputService');
    const musicAssistantInputService = new musicAssistantInputServiceModule.MusicAssistantInputService(musicAssistantStreamService);

    const spotifyInputServiceModule = require('../src/adapters/inputs/spotify/spotifyInputService') as typeof import('../src/adapters/inputs/spotify/spotifyInputService');
    const airplayInputServiceModule = require('../src/adapters/inputs/airplay/airplayInputService') as typeof import('../src/adapters/inputs/airplay/airplayInputService');
    let airplayInputService: import('../src/adapters/inputs/airplay/airplayInputService').AirplayInputService | null = null;
    const stopAirplaySession = (zoneId: number, reason?: string) => {
      if (!airplayInputService) {
        throw new Error('airplay input service not initialized');
      }
      airplayInputService.stopActiveSession(zoneId, reason);
    };
    const spotifyInputService = new spotifyInputServiceModule.SpotifyInputService(
      outputHandlersProxy.onOutputError,
      configPort,
      spotifyManagerProvider,
      spotifyDeviceRegistry,
      stopAirplaySession,
    );
    airplayInputService = new airplayInputServiceModule.AirplayInputService((zoneId, reason) => {
      spotifyInputService.stopActiveSession(zoneId, reason);
    });
    if (!airplayInputService) {
      throw new Error('airplay input service not initialized');
    }

    const lineInMetadataServiceModule = require('../src/adapters/inputs/linein/lineInMetadataService') as typeof import('../src/adapters/inputs/linein/lineInMetadataService');
    const lineInMetadataService = new lineInMetadataServiceModule.LineInMetadataService(lineInRegistry);

    const sendspinHookRegistryModule = require('../src/adapters/outputs/sendspin/sendspinHookRegistry') as typeof import('../src/adapters/outputs/sendspin/sendspinHookRegistry');
    const sendspinHookRegistry = new sendspinHookRegistryModule.SendspinHookRegistry();

    const sendspinLineInServiceModule = require('../src/adapters/inputs/linein/sendspinLineInService') as typeof import('../src/adapters/inputs/linein/sendspinLineInService');
    const sendspinLineInService = new sendspinLineInServiceModule.SendspinLineInService(
      lineInRegistry,
      sendspinHookRegistry,
      configPort,
    );

    const { createZoneManager } = require('../src/application/zones/createZoneManager') as typeof import('../src/application/zones/createZoneManager');
    const { createInputsAdapter } = require('../src/adapters/inputs/InputsAdapter') as typeof import('../src/adapters/inputs/InputsAdapter');
    const { createOutputsAdapter } = require('../src/adapters/outputs/OutputsAdapter') as typeof import('../src/adapters/outputs/OutputsAdapter');
    const groupManagerModule = require('../src/application/groups/groupManager') as typeof import('../src/application/groups/groupManager');
    const inputsAdapter = createInputsAdapter({
      airplay: airplayInputService,
      spotify: spotifyInputService,
      musicAssistant: musicAssistantInputService,
      sendspinLineIn: sendspinLineInService,
    });
    const airplayGroupController: AirplayGroupCoordinator = {
      ...noopAirplayGroupController,
    };
    const outputPorts = makeOutputPortsFake(configPort, {
      spotifyManagerProvider,
      spotifyDeviceRegistry,
    });
    outputPorts.airplayGroup = airplayGroupController;
    const outputsAdapter = createOutputsAdapter(outputPorts);
    const recentsManager = createRecentsManager({ notifier: noopNotifier, contentPort: noopContentPort });
    const zoneManager = createZoneManager({
      notifier: noopNotifier,
      inputs: inputsAdapter,
      outputs: outputsAdapter,
      content: noopContentPort,
      config: configPort,
      recents: recentsManager,
      audioManager,
    });
    lineInMetadataService.initOnce({ zoneManager, configPort });
    const groupManager = groupManagerModule.createGroupManager({
      notifier: noopNotifier,
      airplayGroup: airplayGroupController,
    });
    const groupTracker = require('../src/application/groups/groupTracker') as typeof import('../src/application/groups/groupTracker');
    groupManager.initOnce({ zoneManager });
    outputHandlers = zoneManager.getOutputHandlers();
    const updateQueueFromOutput = outputHandlers.onQueueUpdate;

    return {
      tempDir,
      zoneManager,
      updateQueueFromOutput,
      setNotifier: (notifier: NotifierPort) => {
        zoneManager.setNotifier(notifier);
        groupManager.setNotifier(notifier);
      },
      noopNotifier,
      airplayGroupController,
      noopAirplayGroupController,
      groupManager,
      groupTracker,
      cleanup: async () => {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      },
    };
  } finally {
    process.chdir(originalCwd);
  }
}

async function getZoneHarness(): Promise<ZoneHarness> {
  if (!zoneHarnessPromise) {
    zoneHarnessPromise = createZoneHarness();
  }
  return zoneHarnessPromise;
}

function createZoneConfig(id: number, name: string): ZoneConfig {
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

async function withTempCwd<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const originalCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lox-audioserver-tests-'));
  process.chdir(tempDir);
  try {
    return await fn(tempDir);
  } finally {
    process.chdir(originalCwd);
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}


class FakeProcess extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly stdin = new PassThrough();
  public killed = false;
  public readonly signals: string[] = [];

  constructor(private readonly exitOnKill: boolean) {
    super();
  }

  public kill(signal: string): boolean {
    this.signals.push(signal);
    if (signal === 'SIGKILL') {
      this.killed = true;
    }
    if (this.exitOnKill && signal === 'SIGTERM') {
      this.emit('exit', 0, null);
    }
    return true;
  }

  public removeAllListeners(): this {
    super.removeAllListeners();
    return this;
  }
}

const childProcess = require('node:child_process') as {
  spawn: (...args: any[]) => FakeProcess;
};
const originalSpawn = childProcess.spawn;
let spawnImpl: (...args: any[]) => FakeProcess = () => new FakeProcess(true);
childProcess.spawn = (...args: any[]) => spawnImpl(...args);

const { AudioSession } = require('../src/engine/audioSession') as typeof import('../src/engine/audioSession');
const { audioOutputSettings } = require('../src/engine/audioFormat') as typeof import('../src/engine/audioFormat');

test('audio session stats report zero subscribers', () => {
  const session = new AudioSession(
    1,
    { kind: 'file', path: '/tmp/fake.wav' },
    'mp3',
    () => undefined,
    audioOutputSettings,
  );
  const stats = session.getStats();
  assert.equal(stats.subscribers, 0);
});

test('pipe source listeners are detached after stop', () => {
  const source = new PassThrough();
  const baseDataListeners = source.listenerCount('data');
  const baseErrorListeners = source.listenerCount('error');
  spawnImpl = () => new FakeProcess(true);
  const session = new AudioSession(
    1,
    { kind: 'pipe', path: '/tmp/fake.pcm', stream: source },
    'pcm',
    () => undefined,
    audioOutputSettings,
  );
  session.start();
  assert.ok(source.listenerCount('data') > baseDataListeners);
  assert.ok(source.listenerCount('error') > baseErrorListeners);
  session.stop();
  assert.equal(source.listenerCount('data'), baseDataListeners);
  assert.equal(source.listenerCount('error'), baseErrorListeners);
});

test('ffmpeg stop issues SIGKILL after timeout', async () => {
  const source = new PassThrough();
  let proc: FakeProcess | null = null;
  spawnImpl = () => {
    proc = new FakeProcess(false);
    return proc;
  };
  const session = new AudioSession(
    1,
    { kind: 'pipe', path: '/tmp/fake.pcm', stream: source },
    'pcm',
    () => undefined,
    audioOutputSettings,
  );
  session.start();
  session.stop();
  await new Promise((resolve) => setTimeout(resolve, 2200));
  if (!proc) {
    throw new Error('ffmpeg process not captured');
  }
  const captured = proc as unknown as { signals: string[] };
  assert.deepEqual(captured.signals, ['SIGTERM', 'SIGKILL']);
});

test('applyZonePatch merges fields', () => {
  const state: LoxoneZoneState = {
    album: 'Old Album',
    artist: 'Old Artist',
    audiopath: 'spotify:track:old',
    audiotype: 0,
    clientState: 'on',
    coverurl: '',
    duration: 120,
    mode: 'play',
    name: 'Living',
    parent: null,
    playerid: 1,
    plrepeat: 0,
    plshuffle: 0,
    power: 'on',
    qindex: 0,
    queueAuthority: 'local',
    sourceName: 'src',
    station: '',
    time: 0,
    title: 'Old Title',
    type: 3,
    volume: 20,
  };
  const next = applyZonePatch(state, { title: 'New Title', volume: 30 });
  assert.equal(next.title, 'New Title');
  assert.equal(next.volume, 30);
  assert.equal(next.artist, 'Old Artist');
});

test('applyZonePatch does not mutate inputs', () => {
  const state: LoxoneZoneState = {
    album: '',
    artist: '',
    audiopath: '',
    audiotype: 0,
    clientState: 'on',
    coverurl: '',
    duration: 0,
    mode: 'stop',
    name: 'Zone',
    parent: null,
    playerid: 2,
    plrepeat: 0,
    plshuffle: 0,
    power: 'on',
    qindex: 0,
    queueAuthority: 'local',
    sourceName: 'src',
    station: '',
    time: 0,
    title: '',
    type: 3,
    volume: 10,
  };
  const patch = { title: 'Now Playing' };
  const next = applyZonePatch(state, patch);
  assert.equal(state.title, '');
  assert.equal(patch.title, 'Now Playing');
  assert.notEqual(next, state);
});

test('zone queue transitions update state and notify', async () => {
  const harness = await getZoneHarness();
  const {
    zoneManager,
    updateQueueFromOutput,
    setNotifier,
    noopNotifier,
  } = harness;

  const notifications: {
    queue: Array<{ zoneId: number; size: number }>;
    states: Array<{ zoneId: number; audiopath?: string; qindex?: number }>;
  } = { queue: [], states: [] };

  const notifier: NotifierPort = {
    ...noopNotifier,
    notifyQueueUpdated: (zoneId, queueSize) => notifications.queue.push({ zoneId, size: queueSize }),
    notifyZoneStateChanged: (state) =>
      notifications.states.push({ zoneId: state.playerid, audiopath: state.audiopath, qindex: state.qindex }),
  };
  setNotifier(notifier);

  await zoneManager.replaceAll([createZoneConfig(1, 'Living')], {
    airplay: { enabled: false },
    spotify: { enabled: false },
  });

  const initial = [
    makeQueueItem({ audiopath: 'spotify:track:one', title: 'One', artist: 'Artist', duration: 180, qindex: 0 }),
    makeQueueItem({ audiopath: 'spotify:track:two', title: 'Two', artist: 'Artist', duration: 200, qindex: 1 }),
  ];
  updateQueueFromOutput(1, initial, 0);
  assert.equal(zoneManager.getQueue(1, 0, 10).totalitems, 2);
  assert.equal(zoneManager.getState(1)?.audiopath, 'spotify:track:one');
  assert.equal(notifications.queue.at(-1)?.size, 2);

  const added = [
    ...initial,
    makeQueueItem({ audiopath: 'spotify:track:three', title: 'Three', artist: 'Artist', duration: 120, qindex: 2 }),
  ];
  updateQueueFromOutput(1, added, 1);
  assert.equal(zoneManager.getQueue(1, 0, 10).totalitems, 3);
  assert.equal(zoneManager.getState(1)?.audiopath, 'spotify:track:two');
  assert.equal(notifications.queue.at(-1)?.size, 3);

  const reordered = [
    makeQueueItem({ ...added[2], qindex: 0 }),
    makeQueueItem({ ...added[0], qindex: 1 }),
  ];
  updateQueueFromOutput(1, reordered, 0);
  assert.equal(zoneManager.getQueue(1, 0, 10).totalitems, 2);
  assert.equal(zoneManager.getState(1)?.audiopath, 'spotify:track:three');
  assert.equal(notifications.queue.at(-1)?.size, 2);

  const merge = [
    makeQueueItem({ ...reordered[1], title: 'One (Updated)', qindex: 1 }),
  ];
  updateQueueFromOutput(1, merge, 1);
  const queue = zoneManager.getQueue(1, 0, 10);
  assert.equal(queue.totalitems, 2);
  assert.equal(zoneManager.getState(1)?.audiopath, 'spotify:track:one');
  assert.ok(queue.items.some((item) => item.title === 'One (Updated)'));

  setNotifier(noopNotifier);
});

test('group join/leave emits audio sync payloads', async () => {
  const harness = await getZoneHarness();
  const {
    zoneManager,
    setNotifier,
    noopNotifier,
    airplayGroupController,
    noopAirplayGroupController,
    groupTracker,
  } = harness;

  const audioSyncEvents: Array<any> = [];
  const syncCalls: number[] = [];
  const stopCalls: Array<{ leader: number; members: number[] }> = [];

  const notifier: NotifierPort = {
    ...noopNotifier,
    notifyAudioSyncEvent: (payload) => audioSyncEvents.push(payload),
  };
  setNotifier(notifier);
  Object.assign(airplayGroupController, {
    ...noopAirplayGroupController,
    syncCurrentGroup: async (leaderId: number) => {
      syncCalls.push(leaderId);
    },
    stopGroupMembers: async (leaderId: number, members: number[]) => {
      stopCalls.push({ leader: leaderId, members });
    },
  });

  await zoneManager.replaceAll([createZoneConfig(1, 'Living'), createZoneConfig(2, 'Kitchen')], {
    airplay: { enabled: false },
    spotify: { enabled: false },
  });

  const { upsertGroup, removeGroupByLeader, getGroupByLeader } = groupTracker;
  upsertGroup({
    leader: 1,
    members: [2],
    backend: 'internal',
    externalId: 'group-1',
    source: 'manual',
  });

  assert.equal(getGroupByLeader(1)?.members.length, 2);
  assert.ok(syncCalls.includes(1));
  const createdPayload = audioSyncEvents.at(-1)?.[0];
  assert.ok(createdPayload);
  assert.equal(createdPayload.group, 'group-1');
  assert.equal(createdPayload.players.length, 2);

  removeGroupByLeader(1);
  assert.ok(stopCalls.some((call) => call.leader === 1));
  const removedPayload = audioSyncEvents.at(-1)?.[0];
  assert.equal(removedPayload.players.length, 0);

  Object.assign(airplayGroupController, noopAirplayGroupController);
  setNotifier(noopNotifier);
});

test('output routing switches active output and stops previous', () => {
  const { dispatchOutputs } = require('../src/application/zones/services/outputOrchestrator') as typeof import('../src/application/zones/services/outputOrchestrator');

  const calls: Record<string, string[]> = { sendspin: [], dlna: [] };
  const makeOutput = (type: string, ready: boolean) => ({
    type,
    isReady: () => ready,
    play: () => {
      calls[type].push('play');
    },
    pause: () => {
      calls[type].push('pause');
    },
    resume: () => {
      calls[type].push('resume');
    },
    stop: () => {
      calls[type].push('stop');
    },
    dispose: () => undefined,
  });

  const sendspin = makeOutput('sendspin', true);
  const dlna = makeOutput('dlna', false);

  const ctx = {
    id: 1,
    name: 'Living',
    config: createZoneConfig(1, 'Living'),
    activeInput: null,
    activeOutput: 'dlna',
    activeOutputTypes: new Set<string>(['dlna']),
  } as any;

  const session = {
    zoneId: 1,
    source: 'queue',
    playbackSource: { kind: 'file', path: '/tmp/fake.wav' },
  } as unknown as PlaybackSession;

  const log = { debug: () => undefined, warn: () => undefined, spam: () => undefined };
  const noopOutputError = () => undefined;
  dispatchOutputs(ctx, [sendspin, dlna], 'play', session, log, noopOutputError);

  assert.equal(ctx.activeOutput, 'sendspin');
  assert.equal(calls.dlna.filter((entry) => entry === 'stop').length, 1);
  assert.equal(calls.sendspin.filter((entry) => entry === 'play').length, 1);
});

test('favorites/recents recover from missing and corrupt JSON', async () => {
  await withTempCwd(async () => {
    const favoritesStore = freshRequire<typeof import('../src/application/zones/favorites/favoritesStore')>(
      '../src/application/zones/favorites/favoritesStore',
    );
    const recentsStore = freshRequire<typeof import('../src/application/zones/recents/recentsStore')>(
      '../src/application/zones/recents/recentsStore',
    );

    const missingFavorites = await favoritesStore.loadFavorites(1);
    const missingRecents = await recentsStore.loadRecents(1);
    assert.equal(missingFavorites.items.length, 0);
    assert.equal(missingRecents.items.length, 0);

    await fs.mkdir(path.join(process.cwd(), 'data', 'favorites'), { recursive: true });
    await fs.mkdir(path.join(process.cwd(), 'data', 'recents'), { recursive: true });
    await fs.writeFile(path.join(process.cwd(), 'data', 'favorites', '1.json'), '{not-json');
    await fs.writeFile(path.join(process.cwd(), 'data', 'recents', '1.json'), '{not-json');

    const corruptFavorites = await favoritesStore.loadFavorites(1);
    const corruptRecents = await recentsStore.loadRecents(1);
    assert.equal(corruptFavorites.items.length, 0);
    assert.equal(corruptRecents.items.length, 0);
  });
});

test('config loads defaults and ignores env overrides', async () => {
  await withTempCwd(async () => {
    const originalEnv = process.env.AUDIOSERVER_IP;
    process.env.AUDIOSERVER_IP = '203.0.113.123';
    try {
      const configRepositoryModule = freshRequire<typeof import('../src/application/config/configRepository')>(
        '../src/application/config/configRepository',
      );
      const configAdapterModule = freshRequire<typeof import('../src/adapters/config/ConfigAdapter')>(
        '../src/adapters/config/ConfigAdapter',
      );
      const storage = new StorageAdapter();
      const configRepository = new configRepositoryModule.ConfigRepository(storage);
      const configPort = new configAdapterModule.ConfigAdapter(configRepository);
      const cfg = await configPort.load();
      assert.ok(Array.isArray(cfg.zones));
      assert.equal(cfg.zones.length, 0);
      assert.equal(cfg.system.adminHttp.enabled, true);
      assert.equal(cfg.inputs?.airplay?.enabled, true);
      assert.notEqual(cfg.system.audioserver.ip, '203.0.113.123');

      await fs.writeFile(path.join(process.cwd(), 'data', 'config.json'), '{bad-json');
      const next = await configPort.load();
      assert.equal(next.zones.length, 0);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AUDIOSERVER_IP;
      } else {
        process.env.AUDIOSERVER_IP = originalEnv;
      }
    }
  });
});

async function run(): Promise<void> {
  let failures = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
    }
  }
  childProcess.spawn = originalSpawn;
  if (zoneHarnessPromise) {
    const harness = await zoneHarnessPromise;
    await harness.cleanup();
  }
  if (failures > 0) {
    process.exitCode = 1;
  }
}

void run();
