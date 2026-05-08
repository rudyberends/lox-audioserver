import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import {
  AdminApiHandler,
  buildSqueezeliteAdminPlayerSnapshot,
} from '../src/adapters/http/adminApi/adminApiHandler';
import { readMiniserverBaseUrlFromConfig } from '../src/adapters/http/adminApi/auth/miniserverAuthClient';
import type { ZoneManagerFacade } from '../src/application/zones/createZoneManager';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { ContentPort } from '../src/ports/ContentPort';
import { makeNotifierFake } from './fakes/notifierPort';
import { AudioManager } from '../src/application/playback/audioManager';
import { makePlaybackServiceFake } from './fakes/playbackService';
import { createRecentsManager } from '../src/application/zones/recents/recentsManager';
import { createFavoritesManager } from '../src/application/zones/favorites/favoritesManager';
import { createContentManager } from '../src/adapters/content/contentManager';
import { LineInIngestRegistry } from '../src/adapters/inputs/linein/lineInIngestRegistry';
import { SendspinLineInService } from '../src/adapters/inputs/linein/sendspinLineInService';
import { MusicAssistantStreamService } from '../src/adapters/inputs/musicassistant/musicAssistantStreamService';
import { SpotifyInputService } from '../src/adapters/inputs/spotify/spotifyInputService';
import { SendspinHookRegistry } from '../src/adapters/outputs/sendspin/sendspinHookRegistry';
import { SnapcastCore } from '../src/adapters/outputs/snapcast/snapcastCore';
import { SqueezeliteCore } from '../src/adapters/outputs/squeezelite/squeezeliteCore';
import { ConnectionRegistry } from '../src/adapters/loxone/ws/connectionRegistry';
import { LoxoneWsNotifier } from '../src/adapters/loxone/ws/notifier';
import { CustomRadioStore } from '../src/adapters/content/providers/customRadioStore';
import { SpotifyServiceManagerProvider } from '../src/adapters/content/providers/spotifyServiceManager';
import { SpotifyDeviceRegistry } from '../src/adapters/outputs/spotify/deviceRegistry';
import type { MdnsPort } from '../src/ports/MdnsPort';

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const noopConfigPort: ConfigPort = {
  load: async () => {
    throw new Error('config not configured');
  },
  getConfig: () => {
    throw new Error('config not configured');
  },
  getSystemConfig: () => {
    throw new Error('config not configured');
  },
  getRawAudioConfig: () => {
    throw new Error('config not configured');
  },
  ensureInputs: () => {
    throw new Error('config not configured');
  },
  updateConfig: async () => {
    throw new Error('config not configured');
  },
};
const noopContentPort: ContentPort = {
  getDefaultSpotifyAccountId: () => null,
  resolveMetadata: async () => null,
  resolvePlaybackSource: async () => ({ playbackSource: null, provider: 'library' }),
  configureAppleMusic: () => {},
  configureDeezer: () => {},
  configureTidal: () => {},
  configureYtMusic: () => {},
  isAppleMusicProvider: () => false,
  isDeezerProvider: () => false,
  isTidalProvider: () => false,
  isYtMusicProvider: () => false,
  getMediaFolder: async () => null,
  getServiceTrack: async () => null,
  getServiceFolder: async () => null,
  buildQueueForUri: async () => [],
};

const noopMdnsPort: MdnsPort = {
  publish: () => ({ stop: () => {} }),
  browse: () => ({ stop: () => {} }),
  shutdown: () => {},
};

class FakeResponse extends EventEmitter {
  public statusCode: number | null = null;
  public headers: Record<string, string> | null = null;
  public body = '';
  public writableEnded = false;

  public writeHead(status: number, headers: Record<string, string>): void {
    this.statusCode = status;
    this.headers = headers;
  }

  public end(data?: string | Buffer): void {
    if (data !== undefined) {
      this.body += data.toString();
    }
    this.writableEnded = true;
    this.emit('finish');
  }
}

function createHandler(): AdminApiHandler {
  const lineInRegistry = new LineInIngestRegistry();
  const sendspinHookRegistry = new SendspinHookRegistry();
  const sendspinLineInService = new SendspinLineInService(
    lineInRegistry,
    sendspinHookRegistry,
    noopConfigPort,
  );
  const audioManager = new AudioManager(makePlaybackServiceFake(), {
    notifyOutputError: () => {
      /* noop */
    },
    notifyOutputState: () => {
      /* noop */
    },
  });
  const outputHandlers = {
    onQueueUpdate: () => {
      /* noop */
    },
    onOutputError: () => {
      /* noop */
    },
  };
  const spotifyManagerProvider = new SpotifyServiceManagerProvider(noopConfigPort);
  const spotifyDeviceRegistry = new SpotifyDeviceRegistry();
  const musicAssistantStreamService = new MusicAssistantStreamService(outputHandlers, noopConfigPort);
  const spotifyInputService = new SpotifyInputService(
    outputHandlers.onOutputError,
    noopConfigPort,
    spotifyManagerProvider,
    spotifyDeviceRegistry,
    () => {
      throw new Error('airplay session stopper not configured');
    },
  );
  const snapcastCore = new SnapcastCore(audioManager);
  const zoneManager = {} as ZoneManagerFacade;
  snapcastCore.initOnce({ zoneManager });
  const squeezeliteCore = new SqueezeliteCore(noopConfigPort);
  const loxoneNotifier = new LoxoneWsNotifier(new ConnectionRegistry());
  const customRadioStore = new CustomRadioStore();
  const favoritesManager = createFavoritesManager({
    notifier: makeNotifierFake(),
    contentPort: noopContentPort,
  });
  favoritesManager.initOnce({ zoneManager });
  return new AdminApiHandler({
    zoneManager,
    configPort: noopConfigPort,
    notifier: makeNotifierFake(),
    loxoneNotifier,
    spotifyManagerProvider,
    customRadioStore,
    spotifyInputService,
    sendspinLineInService,
    musicAssistantStreamService,
    snapcastCore,
    squeezeliteCore,
    recentsManager: createRecentsManager({ notifier: makeNotifierFake(), contentPort: noopContentPort }),
    favoritesManager,
    groupManager: { getAllGroups: () => [] },
    contentManager: createContentManager({
      notifier: makeNotifierFake(),
      configPort: noopConfigPort,
      spotifyManagerProvider,
      customRadioStore,
    }),
    audioManager,
    mdnsPort: noopMdnsPort,
  });
}

test('readJsonBody parses valid json under limit', async () => {
  const handler = createHandler();
  const stream = new PassThrough();
  const req = stream as unknown as IncomingMessage;
  const res = new FakeResponse();
  const promise = (handler as any).readJsonBody(req, res as unknown as ServerResponse);
  stream.end('{"ok":true}');

  const body = await promise;
  assert.deepEqual(body, { ok: true });
  assert.equal(res.writableEnded, false);
  assert.equal(res.statusCode, null);
});

test('buildSqueezeliteAdminPlayerSnapshot matches configured player MAC', () => {
  const snapshot = buildSqueezeliteAdminPlayerSnapshot(
    { id: 'squeezelite', playerId: '02:8c:54:a9:dc:ac' },
    [{ playerId: '028c54a9dcac', name: 'Test1' }],
  );

  assert.deepEqual(snapshot, {
    mac: '02:8C:54:A9:DC:AC',
    name: 'Test1',
    connected: true,
  });
});

test('buildSqueezeliteAdminPlayerSnapshot uses single connected player without configured target', () => {
  const snapshot = buildSqueezeliteAdminPlayerSnapshot(
    { id: 'squeezelite' },
    [{ playerId: 'aa:bb:cc:dd:ee:ff', name: 'Living Room' }],
  );

  assert.deepEqual(snapshot, {
    mac: 'AA:BB:CC:DD:EE:FF',
    name: 'Living Room',
    connected: true,
  });
});

test('buildSqueezeliteAdminPlayerSnapshot exposes disconnected configured target', () => {
  const snapshot = buildSqueezeliteAdminPlayerSnapshot(
    { id: 'squeezelite', playerId: '02:8c:54:a9:dc:ac', playerName: 'Test1' },
    [],
  );

  assert.deepEqual(snapshot, {
    mac: '02:8C:54:A9:DC:AC',
    name: 'Test1',
    connected: false,
  });
});

test('readJsonBody rejects invalid json with 400', async () => {
  const handler = createHandler();
  const stream = new PassThrough();
  const req = stream as unknown as IncomingMessage;
  const res = new FakeResponse();
  const promise = (handler as any).readJsonBody(req, res as unknown as ServerResponse);
  stream.end('{"bad":');

  const body = await promise;
  assert.equal(body, null);
  assert.equal(res.statusCode, 400);
  assert.equal(res.writableEnded, true);
  assert.equal(JSON.parse(res.body).error, 'invalid-json');
});

test('readJsonBody rejects oversized payloads with 413', async () => {
  const handler = createHandler();
  const stream = new PassThrough();
  const req = stream as unknown as IncomingMessage;
  const res = new FakeResponse();
  const promise = (handler as any).readJsonBody(req, res as unknown as ServerResponse);
  stream.write(Buffer.alloc(MAX_JSON_BODY_BYTES + 1, 'a'));
  stream.end();

  const body = await promise;
  assert.equal(body, null);
  assert.equal(res.statusCode, 413);
  assert.equal(res.writableEnded, true);
  assert.equal(JSON.parse(res.body).error, 'payload-too-large');
});

test('readJsonBody supports route-specific max size override', async () => {
  const handler = createHandler();
  const stream = new PassThrough();
  const req = stream as unknown as IncomingMessage;
  const res = new FakeResponse();
  const promise = (handler as any).readJsonBody(req, res as unknown as ServerResponse, MAX_JSON_BODY_BYTES + 64);
  stream.write(Buffer.alloc(MAX_JSON_BODY_BYTES + 1, 'a'));
  stream.end();

  const body = await promise;
  assert.equal(body, null);
  assert.equal(res.statusCode, 400);
  assert.equal(res.writableEnded, true);
  assert.equal(JSON.parse(res.body).error, 'invalid-json');
});

test('readMiniserverBaseUrlFromConfig returns http url with non-default port', async () => {
  const handler = createHandler();
  const cfg = {
    system: {
      miniserver: { ip: '192.168.1.200', port: 8081, protocol: 'http' },
    },
  };
  void handler;
  const baseUrl = readMiniserverBaseUrlFromConfig(cfg as any);
  assert.equal(baseUrl, 'http://192.168.1.200:8081');
});

test('readMiniserverBaseUrlFromConfig omits default http port', async () => {
  const handler = createHandler();
  const cfg = {
    system: {
      miniserver: { ip: '192.168.1.200', port: 80, protocol: 'http' },
    },
  };
  void handler;
  const baseUrl = readMiniserverBaseUrlFromConfig(cfg as any);
  assert.equal(baseUrl, 'http://192.168.1.200');
});

test('readMiniserverBaseUrlFromConfig omits default https port 443', async () => {
  const handler = createHandler();
  const cfg = {
    system: {
      miniserver: { ip: '192.168.1.200', port: 443, protocol: 'https' },
    },
  };
  void handler;
  const baseUrl = readMiniserverBaseUrlFromConfig(cfg as any);
  assert.equal(baseUrl, 'https://192.168.1.200');
});

test('readMiniserverBaseUrlFromConfig keeps https with custom port', async () => {
  const handler = createHandler();
  const cfg = {
    system: {
      miniserver: { ip: '192.168.1.200', port: 8443, protocol: 'https' },
    },
  };
  void handler;
  const baseUrl = readMiniserverBaseUrlFromConfig(cfg as any);
  assert.equal(baseUrl, 'https://192.168.1.200:8443');
});
