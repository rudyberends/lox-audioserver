import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import { ApiHandler, API_ROOT } from '../src/adapters/http/api/apiHandler';
import { ApiEventHub } from '../src/adapters/http/api/apiEventHub';
import { withApiEvents } from '../src/adapters/http/api/apiNotifierTap';
import { toApiZoneState } from '../src/adapters/http/api/zoneProjection';
import { AudioType } from '../src/domain/zones/enums';
import { COVER_ART_NOW_PLAYING_SIZE } from '../src/shared/coverArt';
import { ServerLifecycle } from '../src/domain/server/lifecycle';
import type { HealthReport } from '../src/domain/server/health';
import type { ZoneState } from '../src/domain/zones/zoneState';
import type { NotifierPort } from '../src/ports/NotifierPort';

// This API is the contract third parties build on, so the tests below guard the
// two promises that make it one: Loxone vocabulary never reaches the wire, and a
// successful command is always followed by an event (so nobody has to poll).

class FakeResponse extends EventEmitter {
  public statusCode: number | null = null;
  public headers: Record<string, unknown> = {};
  public body = '';
  public writableEnded = false;

  public writeHead(status: number, headers?: Record<string, unknown>): this {
    this.statusCode = status;
    if (headers) this.headers = headers;
    return this;
  }

  public write(chunk: string): boolean {
    this.body += chunk;
    return true;
  }

  public end(data?: string | Buffer): void {
    if (data !== undefined) this.body += data.toString();
    this.writableEnded = true;
    this.emit('finish');
  }

  public json(): any {
    return this.body ? JSON.parse(this.body) : null;
  }
}

function makeRequest(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): IncomingMessage {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const stream = Readable.from(payload ? [payload] : []) as unknown as IncomingMessage;
  (stream as any).method = method;
  (stream as any).url = url;
  (stream as any).headers = headers;
  return stream;
}

function zoneState(overrides: Partial<ZoneState> = {}): ZoneState {
  return {
    id: 3,
    name: 'Kitchen',
    mode: 'play',
    power: 'on',
    clientState: 'on',
    time: 42.7,
    duration: 210,
    volume: 40,
    plrepeat: 0,
    plshuffle: 0,
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    coverurl: 'http://cover',
    station: '',
    sourceName: 'Library',
    audiopath: 'library://track/9',
    audiotype: AudioType.File,
    type: 2,
    eq: [0,0,0,0,0,0,0,0,0,0],
    qindex: 0,
    outputProtocol: 'sendspin',
    ...overrides,
  } as ZoneState;
}

type Harness = {
  handler: ApiHandler;
  hub: ApiEventHub;
  commands: Array<{ zoneId: number; command: string; payload?: string }>;
  plays: Array<{ zoneId: number; uri: string }>;
  states: Map<number, ZoneState>;
};

let eqBands: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
let queueOps: string[] = [];
let libOps: string[] = [];
// What the cover route asked for, so the tests can check the size hint it passed on.
let coverAsks: Array<{ zoneId: number; targetSize: number }> = [];
let zoneCover: { data: Buffer; mime?: string } | string | null = null;
let inputSelections: Array<{ zoneId: number; inputId: string }> = [];
let alertCalls: Array<Record<string, unknown>> = [];
let alertResult: { success: boolean; action: 'on' | 'off'; reason?: string } | null = null;
let lifecycle = new ServerLifecycle();
let health: HealthReport;
const favItems = [{ id: 1, name: 'Radio Paradise', source: 'tunein:s1', coverUrl: 'c' }];
const recentItems = [
  { source: 'applemusic:track:1', title: 'One', artist: 'A', album: 'X', coverUrl: 'c', service: 'applemusic' },
];
const queueItems = [
  { id: 'a', title: 'One', artist: 'A', album: 'X', duration: 100, coverUrl: 'c1', source: 'applemusic:track:1' },
  { id: 'b', title: 'Two', artist: 'B', album: 'Y', duration: 200, coverUrl: 'c2', source: 'library://track/2' },
];

function harness(): Harness {
  eqBands = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  queueOps = [];
  libOps = [];
  coverAsks = [];
  zoneCover = { data: Buffer.from('jpegbytes'), mime: 'image/png' };
  inputSelections = [];
  alertCalls = [];
  alertResult = { success: true, action: 'on' };
  lifecycle = new ServerLifecycle();
  lifecycle.markReady();
  health = {
    status: 'ok',
    version: '4.0.0-test',
    uptimeSec: 5,
    phase: 'ready',
    checks: [{ name: 'audio', status: 'ok' }],
  };
  const states = new Map<number, ZoneState>([[3, zoneState()]]);
  const commands: Harness['commands'] = [];
  const plays: Harness['plays'] = [];
  const hub = new ApiEventHub();
  const handler = new ApiHandler({
    eventHub: hub,
    getAllZoneStates: () => [...states.values()],
    getZoneState: (zoneId) => states.get(zoneId) ?? null,
    handleCommand: (zoneId, command, payload) => commands.push({ zoneId, command, payload }),
    playContent: async (zoneId, uri) => {
      plays.push({ zoneId, uri });
    },
    getVolumeLimits: (zoneId) => (zoneId === 3 ? { max: 70, default: 20, step: 2 } : undefined),
    getOutputProtocol: (zoneId) => (zoneId === 9 ? 'sonos' : 'sendspin'),
    getFavorites: async (zoneId, start, limit) =>
      zoneId === 3
        ? { zoneId, items: favItems.slice(start, start + limit), start, total: favItems.length }
        : null,
    addFavorite: async (zoneId, name, uri) => {
      libOps.push(`addFav:${name || '(auto)'}:${uri}`);
      return { id: 9, name: name || 'Auto', source: uri, coverUrl: '' };
    },
    renameFavorite: async (zoneId, id, name) => {
      libOps.push(`renameFav:${id}:${name}`);
    },
    removeFavorite: async (zoneId, id) => {
      libOps.push(`removeFav:${id}`);
    },
    reorderFavorites: async (zoneId, ids) => {
      libOps.push(`reorderFav:${ids.join(',')}`);
    },
    playFavorite: async (zoneId, id) => {
      libOps.push(`playFav:${id}`);
      return favItems.some((f) => f.id === id);
    },
    getRecents: async (zoneId, start, limit) =>
      zoneId === 3
        ? { zoneId, items: recentItems.slice(start, start + limit), start, total: recentItems.length }
        : null,
    clearRecents: async () => {
      libOps.push('clearRecents');
    },
    setGroup: (zoneId, members) => {
      if (zoneId !== 3) return null;
      if (!members.length) return { leader: zoneId, members: [], rejected: [] };
      const rejected: Array<{ id: number; reason: 'protocol-mismatch' | 'zone-not-found' }> = [];
      const ok: number[] = [];
      for (const id of members) {
        if (id === zoneId) continue;
        if (id === 99) rejected.push({ id, reason: 'zone-not-found' });
        else if (id === 9) rejected.push({ id, reason: 'protocol-mismatch' });
        else ok.push(id);
      }
      return { leader: zoneId, members: [zoneId, ...ok], rejected };
    },
    getQueue: (zoneId, start, limit) =>
      zoneId === 3
        ? {
            zoneId,
            items: queueItems.slice(start, start + limit),
            start,
            total: queueItems.length,
            currentIndex: 0,
          }
        : null,
    queueAppend: async (zoneId, uri) => {
      queueOps.push(`append:${uri}`);
    },
    queueInsertNext: async (zoneId, uri) => {
      queueOps.push(`next:${uri}`);
    },
    queuePlay: (zoneId, id) => {
      queueOps.push(`play:${id}`);
      return queueItems.some((i) => i.id === id);
    },
    queueMove: (zoneId, id, before) => {
      queueOps.push(`move:${id}>${before ?? 'end'}`);
      return queueItems.some((i) => i.id === id);
    },
    queueRemove: (zoneId, id) => {
      queueOps.push(`remove:${id}`);
    },
    queueClear: () => {
      queueOps.push('clear');
    },
    queueUndo: () => {
      queueOps.push('undo');
    },
    getInputs: () => [
      { id: 'linein-a', name: 'BeoSound 9000', icon: 'cd-player', controllable: true, reportsMetadata: true },
      { id: 'linein-b', name: 'Turntable', icon: 'turntable', controllable: false, reportsMetadata: false },
    ],
    selectInput: (zoneId, inputId) => {
      if (inputId !== 'linein-a' && inputId !== 'linein-b') return false;
      inputSelections.push({ zoneId, inputId });
      return true;
    },
    getInputLabel: (inputId) => (inputId === 'linein-a' ? 'BeoSound 9000' : null),
    getStreamFormat: () => null,
    playAlert: async (request) => {
      alertCalls.push(request as unknown as Record<string, unknown>);
      return request.zoneId === 3 ? alertResult : null;
    },
    getZoneCover: (zoneId, targetSize) => {
      coverAsks.push({ zoneId, targetSize });
      return zoneId === 3 ? zoneCover : null;
    },
    getServiceLabel: (audiopath) => (audiopath.startsWith('applemusic:') ? 'Apple Music' : null),
    getOutputDevice: (zoneId) =>
      zoneId === 3
        ? { id: '02:8C:54:A9:DC:AC', name: 'Test1', connected: true }
        : undefined,
    getEqualizerBands: (zoneId) => (zoneId === 3 ? [...eqBands] : null),
    setEqualizerBands: async (zoneId, bands) => {
      if (zoneId !== 3) return null;
      if (!Array.isArray(bands) || bands.length !== 10) return null;
      if (!bands.every((b) => typeof b === 'number' && Number.isFinite(b))) return null;
      eqBands = bands.map((b) => Math.min(6, Math.max(-6, Math.round(b as number))));
      return [...eqBands];
    },
    getHealth: () => health,
    getLifecycle: () => lifecycle.snapshot(),
    serverVersion: '4.0.0-test',
    startedAt: Date.now() - 5000,
  });
  return { handler, hub, commands, plays, states };
}

async function call(
  h: Harness,
  method: string,
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  const res = new FakeResponse();
  await h.handler.handle(
    makeRequest(method, url, body, headers),
    res as unknown as ServerResponse,
  );
  return res;
}

test('projection keeps Loxone vocabulary off the wire', () => {
  const api = toApiZoneState(zoneState({ mode: 'pause', plrepeat: 3, plshuffle: 1, time: 42.7 }));

  // The numeric enums, the raw path field name, and the comma-string EQ are the
  // fields that make the Loxone payload unreadable without Loxone's app.
  const keys = Object.keys(api);
  for (const leaked of ['audiotype', 'type', 'icontype', 'equalizerSettings', 'clientState', 'mode', 'plrepeat', 'plshuffle', 'audiopath', 'station', 'playerid', 'parent', 'qindex']) {
    assert.ok(!keys.includes(leaked), `public zone must not expose ${leaked}`);
  }

  assert.equal(api.state, 'paused');
  assert.equal(api.repeat, 'one', 'plrepeat 3 is RepeatMode.Track');
  assert.equal(api.shuffle, true);
  assert.equal(api.id, 3);
  // Position is promised in whole seconds.
  assert.equal(api.position, 43);
});

test('projection maps every AudioType to a readable source kind', () => {
  const cases: Array<[number, string]> = [
    [AudioType.File, 'track'],
    [AudioType.Radio, 'radio'],
    [AudioType.Playlist, 'playlist'],
    [AudioType.LineIn, 'linein'],
    [AudioType.AirPlay, 'airplay'],
    [AudioType.Spotify, 'spotify'],
    [AudioType.Bluetooth, 'bluetooth'],
  ];
  for (const [audiotype, kind] of cases) {
    assert.equal(toApiZoneState(zoneState({ audiotype })).source?.kind, kind);
  }
  // An unknown/new category must degrade, never break a client's parse. The cast
  // is the point: `audiotype` is typed as `AudioType`, so a value outside the enum
  // can only arrive from an older persisted state or a future member — exactly the
  // case a client must survive.
  assert.equal(
    toApiZoneState(zoneState({ audiotype: 99 as AudioType })).source?.kind,
    'unknown',
  );
});

test('projection reports radio station as the source name', () => {
  const api = toApiZoneState(
    zoneState({ audiotype: AudioType.Radio, station: 'Radio Paradise', duration: 0 }),
  );
  assert.equal(api.source?.name, 'Radio Paradise');
  assert.equal(api.duration, 0);
});

test('projection returns null track and null group instead of empty sentinels', () => {
  const api = toApiZoneState(
    zoneState({ title: '', artist: '', album: '', syncedzones: [] }),
  );
  assert.equal(api.track, null, 'an idle zone has no track, not empty strings');
  assert.equal(api.group, null, 'an ungrouped zone has no group');
});

test('an idle zone reports no source instead of leaking the routing MAC', () => {
  // A freshly seeded zone carries `audiotype: 0` (File, not "none") and holds the
  // audioserver's MAC in `sourceName` as an internal routing tag. The native app
  // ignores both while idle, so a naive projection would be the first thing ever
  // to show a MAC address as a human-readable source name.
  const api = toApiZoneState(
    zoneState({
      audiopath: '',
      audiotype: 0,
      sourceName: '000C290E5497',
      title: '',
      artist: '',
      album: '',
    }),
  );
  assert.equal(api.source, null);
  assert.equal(api.track, null);
  assert.ok(!JSON.stringify(api).includes('000C290E5497'), 'no MAC may reach the wire');
});

test('projection surfaces the sync group with the leader first', () => {
  const api = toApiZoneState(zoneState({ syncedzones: [3, 7, 9] }));
  assert.deepEqual(api.group, { leader: 3, members: [3, 7, 9] });
});

test('GET /api/zones returns the projected snapshot', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/zones`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().zones.length, 1);
  assert.equal(res.json().zones[0].name, 'Kitchen');
});

test('GET /api/zones/{id} 404s for an unknown zone', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/zones/99`);
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'zone-not-found');
});

test('transport verbs map onto the shared zone command engine', async () => {
  const h = harness();
  for (const [route, expected] of [
    ['play', 'play'],
    ['pause', 'pause'],
    ['stop', 'off'],
    ['next', 'queueplus'],
    ['previous', 'queueminus'],
  ] as Array<[string, string]>) {
    const res = await call(h, 'POST', `${API_ROOT}/zones/3/${route}`);
    assert.equal(res.statusCode, 204, `${route} should return 204`);
    assert.equal(h.commands.at(-1)?.command, expected);
    assert.equal(h.commands.at(-1)?.zoneId, 3);
  }
});

test('volume accepts an absolute value and a signed delta', async () => {
  const h = harness();
  await call(h, 'PUT', `${API_ROOT}/zones/3/volume`, { volume: 55 });
  assert.deepEqual(h.commands.at(-1), { zoneId: 3, command: 'volume', payload: '55' });

  // Relative stepping is how every physical remote works; a read-then-write
  // client would race with itself.
  await call(h, 'PUT', `${API_ROOT}/zones/3/volume`, { delta: -5 });
  assert.equal(h.commands.at(-1)?.payload, '-5');
  await call(h, 'PUT', `${API_ROOT}/zones/3/volume`, { delta: 5 });
  assert.equal(h.commands.at(-1)?.payload, '+5');
});

test('volume clamps to the documented 0-100 range', async () => {
  const h = harness();
  await call(h, 'PUT', `${API_ROOT}/zones/3/volume`, { volume: 500 });
  assert.equal(h.commands.at(-1)?.payload, '100');
  await call(h, 'PUT', `${API_ROOT}/zones/3/volume`, { volume: -20 });
  assert.equal(h.commands.at(-1)?.payload, '0');
});

test('malformed command bodies are rejected without reaching the engine', async () => {
  const h = harness();
  for (const body of [{ volume: 'loud' }, {}]) {
    const res = await call(h, 'PUT', `${API_ROOT}/zones/3/volume`, body);
    assert.equal(res.statusCode, 400);
  }
  const bad = await call(h, 'PUT', `${API_ROOT}/zones/3/power`, { power: 'maybe' });
  assert.equal(bad.statusCode, 400);
  assert.equal(h.commands.length, 0, 'no invalid request may reach the zone engine');
});

test('a wrong method is a 405, not a silent success', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/zones/3/volume`);
  assert.equal(res.statusCode, 405);
  assert.equal(h.commands.length, 0);
});

test('GET /api/health reports status, version and uptime', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/health`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
  assert.equal(res.json().version, '4.0.0-test');
  assert.ok(res.json().uptimeSec >= 5);
});

test('the events stream opens with a full snapshot so clients render immediately', async () => {
  const h = harness();
  const res = new FakeResponse();
  await h.handler.handle(
    makeRequest('GET', `${API_ROOT}/events`),
    res as unknown as ServerResponse,
  );
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['Content-Type']), /text\/event-stream/);

  const first = JSON.parse(res.body.replace(/^data: /, '').trim());
  assert.equal(first.type, 'server.ready');
  assert.equal(first.zones[0].name, 'Kitchen');
});

test('a zone change reaches the stream as a full zone, never a patch', async () => {
  const h = harness();
  const res = new FakeResponse();
  await h.handler.handle(makeRequest('GET', `${API_ROOT}/events`), res as unknown as ServerResponse);
  res.body = '';

  h.hub.publishZoneChanged(toApiZoneState(zoneState({ title: 'Next song' })));

  const event = JSON.parse(res.body.replace(/^data: /, '').trim());
  assert.equal(event.type, 'zone.changed');
  assert.equal(event.zone.track.title, 'Next song');
  // A full zone means clients need no prior state to interpret an event.
  assert.equal(event.zone.volume, 40);
  assert.equal(event.zone.state, 'playing');
});

test('closing a stream unsubscribes it', async () => {
  const h = harness();
  const req = makeRequest('GET', `${API_ROOT}/events`);
  const res = new FakeResponse();
  await h.handler.handle(req, res as unknown as ServerResponse);
  assert.equal(h.hub.subscriberCount, 1);
  req.emit('close');
  assert.equal(h.hub.subscriberCount, 0);
});

test('the notifier tap feeds the API without disturbing Loxone delivery', () => {
  const delivered: unknown[] = [];
  const inner = {
    notifyZoneStateChanged: (s: ZoneState) => delivered.push(s),
    notifyQueueUpdated: () => {},
    notifyRoomFavoritesChanged: () => {},
    notifyRecentlyPlayedChanged: () => {},
    notifyRescan: () => {},
    notifyReloadMusicApp: () => {},
    notifyAudioSyncEvent: () => {},
  } as unknown as NotifierPort;

  const hub = new ApiEventHub();
  const seen: any[] = [];
  hub.subscribe((e) => seen.push(e));
  const tapped = withApiEvents(inner, hub);

  tapped.notifyZoneStateChanged(zoneState({ title: 'Tapped' }));

  assert.equal(delivered.length, 1, 'Loxone must still receive the state');
  assert.equal(seen.length, 1, 'the API must receive the projected state');
  assert.equal(seen[0].zone.track.title, 'Tapped');
  assert.equal((seen[0].zone as any).audiotype, undefined);
});

test('a failing API subscriber cannot break Loxone delivery', () => {
  const delivered: unknown[] = [];
  const inner = {
    notifyZoneStateChanged: (s: ZoneState) => delivered.push(s),
    notifyQueueUpdated: () => {},
    notifyRoomFavoritesChanged: () => {},
    notifyRecentlyPlayedChanged: () => {},
    notifyRescan: () => {},
    notifyReloadMusicApp: () => {},
    notifyAudioSyncEvent: () => {},
  } as unknown as NotifierPort;

  const hub = new ApiEventHub();
  hub.subscribe(() => {
    throw new Error('subscriber exploded');
  });
  const tapped = withApiEvents(inner, hub);

  tapped.notifyZoneStateChanged(zoneState());

  assert.equal(delivered.length, 1, 'Loxone delivery survives a broken subscriber');
  assert.equal(hub.subscriberCount, 0, 'the broken subscriber is dropped');
});

// The equalizer moved here from /admin/api because an external provider owns it: the
// LoxBerry Squeezelite Multi-Room plugin writes a zone's bands whenever someone moves
// a slider in its own UI (sonn-audio/core#251). Integrators should never need a route
// under /admin/api, which is why that one is gone rather than aliased.

test('equalizer bands round-trip for a configured zone', async () => {
  const h = harness();
  const before = await call(h, 'GET', `${API_ROOT}/zones/3/equalizer`);
  assert.equal(before.statusCode, 200);
  assert.deepEqual(before.json().bands, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

  // The exact body the plugin sends.
  const put = await call(h, 'PUT', `${API_ROOT}/zones/3/equalizer`, {
    bands: [6, 6, 6, 6, 6, 6, 6, 0, -2, 2],
  });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json().bands, [6, 6, 6, 6, 6, 6, 6, 0, -2, 2]);

  const after = await call(h, 'GET', `${API_ROOT}/zones/3/equalizer`);
  assert.deepEqual(after.json().bands, [6, 6, 6, 6, 6, 6, 6, 0, -2, 2]);
});

test('equalizer is readable without live playback state', async () => {
  // It is configuration, not playback, so it must not require a zone that is
  // currently streaming — an idle zone still has an equalizer to configure.
  const h = harness();
  h.states.clear();
  const res = await call(h, 'GET', `${API_ROOT}/zones/3/equalizer`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().zoneId, 3);
});

test('equalizer rejects a band array that is not ten values', async () => {
  const h = harness();
  for (const bands of [[1, 2], new Array(11).fill(0), 'loud', null]) {
    const res = await call(h, 'PUT', `${API_ROOT}/zones/3/equalizer`, { bands });
    assert.equal(res.statusCode, 400, `rejects ${JSON.stringify(bands)}`);
    assert.equal(res.json().error, 'invalid-equalizer-bands');
  }
  // And nothing was applied.
  const after = await call(h, 'GET', `${API_ROOT}/zones/3/equalizer`);
  assert.deepEqual(after.json().bands, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('equalizer 404s an unknown zone and 405s a wrong method', async () => {
  const h = harness();
  assert.equal((await call(h, 'GET', `${API_ROOT}/zones/99/equalizer`)).statusCode, 404);
  assert.equal((await call(h, 'POST', `${API_ROOT}/zones/3/equalizer`)).statusCode, 405);
});

// A caller mapping its own devices onto zones needs the device identity from the same
// read that gives it zone state, on an idle zone as much as a playing one
// (sonn-audio/core#247).

test('a zone reports which device its output plays to', async () => {
  const h = harness();
  const zone = (await call(h, 'GET', `${API_ROOT}/zones/3`)).json();
  assert.deepEqual(zone.output, {
    protocol: 'sendspin',
    device: { id: '02:8C:54:A9:DC:AC', name: 'Test1', connected: true },
  });
});

test('device identity is reported on an idle zone too', async () => {
  const h = harness();
  h.states.set(3, zoneState({ mode: 'stop', title: '', artist: '', album: '', audiopath: '' }));
  const zone = (await call(h, 'GET', `${API_ROOT}/zones/3`)).json();
  assert.equal(zone.state, 'stopped');
  assert.equal(zone.track, null, 'nothing playing');
  assert.equal(zone.output?.device?.id, '02:8C:54:A9:DC:AC', 'yet the device is known');
});

test('an event describes a zone exactly as a read does', async () => {
  // If the event stream omitted output.device, a client would watch it appear and
  // disappear depending on which path it last heard from.
  const h = harness();
  const res = new FakeResponse();
  await h.handler.handle(makeRequest('GET', `${API_ROOT}/events`), res as unknown as ServerResponse);
  const ready = JSON.parse(res.body.replace(/^data: /, '').trim());
  const read = (await call(h, 'GET', `${API_ROOT}/zones/3`)).json();
  assert.deepEqual(ready.zones[0], read, 'snapshot and read agree');
});

// The path carries the version. Additive changes are safe without one, but a field
// that has to be renamed cannot be — and by the time that is clear, integrators have
// shipped. These pin the version so it cannot be dropped back out by accident.

test('the API is served under a versioned path', async () => {
  const h = harness();
  assert.equal(API_ROOT, '/api/v1');
  assert.equal((await call(h, 'GET', `${API_ROOT}/health`)).statusCode, 200);
  assert.equal((await call(h, 'GET', `${API_ROOT}/zones`)).statusCode, 200);
  assert.equal((await call(h, 'GET', `${API_ROOT}/zones/3`)).statusCode, 200);
});

test('an unversioned request is told where the API went', async () => {
  // It would otherwise fall through to the static file handler and answer a caller
  // written against the beta with an HTML page.
  const h = harness();
  for (const path of ['/api', '/api/zones', '/api/health', '/api/zones/3/volume']) {
    const res = await call(h, 'GET', path);
    assert.equal(res.statusCode, 404, `${path} is refused`);
    assert.equal(res.json().error, 'api-version-required');
    assert.ok(
      String(res.json().message).includes(API_ROOT),
      'and says which prefix to use instead',
    );
  }
});

test('the versioned prefix is matched before the unversioned one', async () => {
  // `/api/v1/zones` also starts with `/api/`, so checking the legacy prefix first
  // would swallow every real request.
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/zones`);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.json().zones));
});

test('an unknown path under the version is a plain not-found', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/nope`);
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'not-found', 'not the version message');
});

// Mozart (B&O) reports what a source and a volume will accept, not just their current
// value. Ours did not, so a client had to infer seekability from `duration === 0` and
// discover a volume cap by writing past it.

test('a zone reports what its volume will accept', async () => {
  const h = harness();
  const zone = (await call(h, 'GET', `${API_ROOT}/zones/3`)).json();
  assert.deepEqual(zone.volumeLimits, { max: 70, default: 20, step: 2 });
  assert.equal(zone.volume, 40, 'the current level is still its own field');
});

test('a source says whether it can be seeked', async () => {
  const h = harness();
  const track = (await call(h, 'GET', `${API_ROOT}/zones/3`)).json();
  assert.equal(track.source.seekable, true, 'a track has a position to seek to');

  // Live radio has no length, so there is nowhere to seek.
  h.states.set(3, zoneState({ audiotype: AudioType.Radio, station: 'Radio Paradise', duration: 0 }));
  const radio = (await call(h, 'GET', `${API_ROOT}/zones/3`)).json();
  assert.equal(radio.source.seekable, false);
  assert.equal(radio.duration, 0, 'which is what a client used to have to infer from');
});

test('an event reports limits and seekability like a read does', async () => {
  const h = harness();
  const res = new FakeResponse();
  await h.handler.handle(makeRequest('GET', `${API_ROOT}/events`), res as unknown as ServerResponse);
  const ready = JSON.parse(res.body.replace(/^data: /, '').trim());
  const read = (await call(h, 'GET', `${API_ROOT}/zones/3`)).json();
  assert.deepEqual(ready.zones[0], read);
});

// A zone.changed is ~550 bytes and a progress tick fires every second per playing
// zone, so the clock advancing must not cost a whole zone.

test('a progress tick is sent when only the position moved', () => {
  const hub = new ApiEventHub();
  const seen: any[] = [];
  hub.subscribe((e) => seen.push(e));
  const at = (time: number, extra: Partial<ZoneState> = {}) =>
    toApiZoneState(zoneState({ time, ...extra }));

  hub.publishZoneChanged(at(10));
  assert.equal(seen[0].type, 'zone.changed', 'the first publish has nothing to compare to');

  hub.publishZoneChanged(at(11));
  hub.publishZoneChanged(at(12));
  assert.deepEqual(
    seen.slice(1).map((e) => [e.type, e.position]),
    [['zone.progress', 11], ['zone.progress', 12]],
  );
});

test('anything other than the position sends the whole zone', () => {
  const hub = new ApiEventHub();
  const seen: any[] = [];
  hub.subscribe((e) => seen.push(e));
  const at = (time: number, extra: Partial<ZoneState> = {}) =>
    toApiZoneState(zoneState({ time, ...extra }));

  hub.publishZoneChanged(at(10));
  // Volume moved as well, so a client that ignores progress events must still see it.
  hub.publishZoneChanged(at(11, { volume: 55 }));
  hub.publishZoneChanged(at(12, { volume: 55, title: 'Next' }));

  assert.deepEqual(seen.map((e) => e.type), ['zone.changed', 'zone.changed', 'zone.changed']);
  assert.equal(seen[1].zone.volume, 55);
  assert.equal(seen[2].zone.track.title, 'Next');
});

test('progress is tracked per zone, so one zone cannot mask another', () => {
  const hub = new ApiEventHub();
  const seen: any[] = [];
  hub.subscribe((e) => seen.push(e));
  hub.publishZoneChanged(toApiZoneState(zoneState({ id: 3, time: 10 })));
  hub.publishZoneChanged(toApiZoneState(zoneState({ id: 7, time: 10 })));
  // Zone 7's first publish is its own baseline, not a tick against zone 3.
  assert.deepEqual(seen.map((e) => e.type), ['zone.changed', 'zone.changed']);

  hub.publishZoneChanged(toApiZoneState(zoneState({ id: 7, time: 11 })));
  assert.equal(seen[2].type, 'zone.progress');
  assert.equal(seen[2].id, 7);
});

// Without a body, /play resumes what is queued — which is all this API could do at
// first, making it a remote rather than something an automation can trigger.

test('play with a uri starts it, play without one resumes', async () => {
  const h = harness();
  const resumed = await call(h, 'POST', `${API_ROOT}/zones/3/play`);
  assert.equal(resumed.statusCode, 204);
  assert.equal(h.commands.at(-1)?.command, 'play', 'resume goes to the command engine');
  assert.equal(h.plays.length, 0, 'and starts nothing new');

  const started = await call(h, 'POST', `${API_ROOT}/zones/3/play`, {
    uri: 'http://example/stream.mp3',
  });
  assert.equal(started.statusCode, 204);
  assert.deepEqual(h.plays.at(-1), { zoneId: 3, uri: 'http://example/stream.mp3' });
});

test('play accepts a source.id back, so a client can restart what it saw', async () => {
  // The zone reports `source.id` as an opaque value; handing it back is how an
  // integration replays something without knowing our content model.
  const h = harness();
  const zone = (await call(h, 'GET', `${API_ROOT}/zones/3`)).json();
  const id = zone.source.id;
  assert.ok(id, 'the zone reports an id to hand back');

  const res = await call(h, 'POST', `${API_ROOT}/zones/3/play`, { uri: id });
  assert.equal(res.statusCode, 204);
  assert.equal(h.plays.at(-1)?.uri, id);
});

test('play rejects an empty uri rather than silently resuming', async () => {
  const h = harness();
  for (const uri of ['', '   ', 42, null]) {
    const res = await call(h, 'POST', `${API_ROOT}/zones/3/play`, { uri });
    assert.equal(res.statusCode, 400, `rejects ${JSON.stringify(uri)}`);
    assert.equal(res.json().error, 'invalid-uri');
  }
  assert.equal(h.plays.length, 0);
  assert.equal(h.commands.length, 0, 'and does not fall back to resume');
});

test('the other transport verbs still take no body', async () => {
  const h = harness();
  for (const verb of ['pause', 'stop', 'next', 'previous']) {
    const res = await call(h, 'POST', `${API_ROOT}/zones/3/${verb}`);
    assert.equal(res.statusCode, 204, verb);
  }
  assert.equal(h.plays.length, 0);
});

// Both of these showed up in a live payload: an Apple Music track reporting "Spotify"
// as its source, and a zone reporting no output while audio was playing.

test('a bridged service is named for itself, not for its Loxone disguise', () => {
  // `sourceName` carries the name the Loxone clients need, and they only know Spotify —
  // so an Apple Music track arrives labelled "Spotify". The audiopath is service-native
  // by then, so the real name is derivable.
  const state = zoneState({
    audiopath: 'applemusic:track:b64_MTc4MDM4MjY5NQ==',
    sourceName: 'Spotify',
  });

  const disguised = toApiZoneState(state);
  assert.equal(disguised.source?.name, 'Spotify', 'without a lookup it falls back');

  const named = toApiZoneState(state, {
    serviceLabel: (p) => (p.startsWith('applemusic:') ? 'Apple Music' : null),
  });
  assert.equal(named.source?.name, 'Apple Music');
  assert.equal(named.source?.id, state.audiopath, 'the id is untouched');
});

test('a playing zone reports its output', () => {
  // `state.outputProtocol` is only ever filled in by the Loxone notifier at emit time,
  // so reading it here reported `output: null` even mid-playback.
  const state = zoneState({ outputProtocol: undefined });
  assert.equal(toApiZoneState(state).output, null, 'nothing to report without a lookup');

  const resolved = toApiZoneState(state, { outputProtocol: () => 'sendspin' });
  assert.deepEqual(resolved.output, { protocol: 'sendspin' });
});

test('the resolved output still carries its device', () => {
  const resolved = toApiZoneState(zoneState({ outputProtocol: undefined }), {
    outputProtocol: () => 'squeezelite',
    device: () => ({ id: '02:8C:54:A9:DC:AC', name: 'Test1', connected: true }),
  });
  assert.deepEqual(resolved.output, {
    protocol: 'squeezelite',
    device: { id: '02:8C:54:A9:DC:AC', name: 'Test1', connected: true },
  });
});

test('a service-native audiopath decides the kind, not audiotype', () => {
  // `audiotype` is shaped for the Loxone clients: a bridged service becomes Spotify and
  // is then downgraded to Playlist whenever the queue is not Spotify-owned, which labels
  // a single Apple Music track a playlist. The audiopath says what it actually is.
  const track = toApiZoneState(
    zoneState({
      audiopath: 'applemusic:track:b64_MTc4MDM4MjY5NQ==',
      audiotype: AudioType.Playlist,
    }),
  );
  assert.equal(track.source?.kind, 'track');

  const playlist = toApiZoneState(
    zoneState({ audiopath: 'applemusic:playlist:pl.42', audiotype: AudioType.Playlist }),
  );
  assert.equal(playlist.source?.kind, 'playlist');

  // An album is not a kind of its own — playing one queues its tracks.
  const album = toApiZoneState(
    zoneState({ audiopath: 'applemusic:album:123', audiotype: AudioType.Playlist }),
  );
  assert.equal(album.source?.kind, 'playlist');

  // Anything without a service-native path still falls back to audiotype.
  const local = toApiZoneState(
    zoneState({ audiopath: 'library://track/9', audiotype: AudioType.File }),
  );
  assert.equal(local.source?.kind, 'track');
});

// The Loxone dialect spends eight commands on the queue (queueadd, queueinsert,
// queueandplay, queue/play, queue/move/…/before/…, queue/remove, queue/clear,
// queueundo). Same capabilities here, addressed by what they do to the collection.

test('the queue reads as a page, with real source ids', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/zones/3/queue`);
  assert.equal(res.statusCode, 200);
  const q = res.json();
  assert.equal(q.zoneId, 3);
  assert.equal(q.total, 2);
  assert.equal(q.currentIndex, 0);
  // Not collapsed to `spotify:…` the way the Loxone queue payload has to be.
  assert.equal(q.items[0].source, 'applemusic:track:1');
  assert.equal(q.items[0].id, 'a', 'the entry handle, for move and remove');
});

test('the queue pages', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/zones/3/queue?start=1&limit=1`);
  const q = res.json();
  assert.equal(q.items.length, 1);
  assert.equal(q.items[0].id, 'b');
  assert.equal(q.start, 1);
  assert.equal(q.total, 2, 'total is the whole queue, not the page');
});

test('posting to the queue appends, or inserts next', async () => {
  const h = harness();
  assert.equal((await call(h, 'POST', `${API_ROOT}/zones/3/queue`, { uri: 'x:1' })).statusCode, 204);
  assert.equal(
    (await call(h, 'POST', `${API_ROOT}/zones/3/queue`, { uri: 'x:2', next: true })).statusCode,
    204,
  );
  assert.deepEqual(queueOps, ['append:x:1', 'next:x:2']);

  const bad = await call(h, 'POST', `${API_ROOT}/zones/3/queue`, {});
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'invalid-uri');
});

test('patching the queue jumps to an entry or reorders one', async () => {
  const h = harness();
  assert.equal((await call(h, 'PATCH', `${API_ROOT}/zones/3/queue`, { play: 'b' })).statusCode, 204);
  assert.equal(
    (await call(h, 'PATCH', `${API_ROOT}/zones/3/queue`, { move: 'a', before: 'b' })).statusCode,
    204,
  );
  // No `before` means the end.
  assert.equal((await call(h, 'PATCH', `${API_ROOT}/zones/3/queue`, { move: 'a' })).statusCode, 204);
  assert.deepEqual(queueOps, ['play:b', 'move:a>b', 'move:a>end']);

  const gone = await call(h, 'PATCH', `${API_ROOT}/zones/3/queue`, { play: 'nope' });
  assert.equal(gone.statusCode, 404);
  assert.equal(gone.json().error, 'queue-item-not-found');

  const empty = await call(h, 'PATCH', `${API_ROOT}/zones/3/queue`, {});
  assert.equal(empty.statusCode, 400);
});

test('deleting from the queue removes one, clears all, or undoes', async () => {
  const h = harness();
  assert.equal((await call(h, 'DELETE', `${API_ROOT}/zones/3/queue`, { id: 'a' })).statusCode, 204);
  assert.equal((await call(h, 'DELETE', `${API_ROOT}/zones/3/queue`, { all: true })).statusCode, 204);
  assert.equal((await call(h, 'DELETE', `${API_ROOT}/zones/3/queue`, { undo: true })).statusCode, 204);
  assert.deepEqual(queueOps, ['remove:a', 'clear', 'undo']);

  // Clearing everything has to be asked for, not be what an empty body happens to mean.
  const vague = await call(h, 'DELETE', `${API_ROOT}/zones/3/queue`, {});
  assert.equal(vague.statusCode, 400);
  assert.equal(vague.json().error, 'invalid-queue-delete');
});

test('repeat and shuffle can be set, not only read', async () => {
  // ZoneState reported both from the start while the API had no way to change them.
  const h = harness();
  for (const [mode, expected] of [['all', 'all'], ['one', 'one'], ['off', 'off']] as const) {
    const res = await call(h, 'PUT', `${API_ROOT}/zones/3/repeat`, { repeat: mode });
    assert.equal(res.statusCode, 204);
    assert.deepEqual(h.commands.at(-1), { zoneId: 3, command: 'repeat', payload: expected });
  }
  assert.equal((await call(h, 'PUT', `${API_ROOT}/zones/3/repeat`, { repeat: 'sometimes' })).statusCode, 400);

  await call(h, 'PUT', `${API_ROOT}/zones/3/shuffle`, { shuffle: true });
  assert.equal(h.commands.at(-1)?.payload, 'on');
  await call(h, 'PUT', `${API_ROOT}/zones/3/shuffle`, { shuffle: false });
  assert.equal(h.commands.at(-1)?.payload, 'off');
  assert.equal((await call(h, 'PUT', `${API_ROOT}/zones/3/shuffle`, { shuffle: 'yes' })).statusCode, 400);
});

test('repeat maps to the same numbers the engine and outputs use', () => {
  // RepeatMode.Queue = 1 is "all", Track = 3 is "one". These were swapped here.
  assert.equal(toApiZoneState(zoneState({ plrepeat: 1 })).repeat, 'all');
  assert.equal(toApiZoneState(zoneState({ plrepeat: 3 })).repeat, 'one');
  assert.equal(toApiZoneState(zoneState({ plrepeat: 0 })).repeat, 'off');
});

// Favourites, recents and grouping: the last three things the own player still needed
// the Loxone protocol for.

test('favourites read, add, rename, reorder, play and remove', async () => {
  const h = harness();
  const list = await call(h, 'GET', `${API_ROOT}/zones/3/favorites`);
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().items[0].id, 1);
  // The Loxone slot/plus pair describes their button grid, not the favourite.
  assert.ok(!('slot' in list.json().items[0]));
  assert.ok(!('plus' in list.json().items[0]));

  const created = await call(h, 'POST', `${API_ROOT}/zones/3/favorites`, { uri: 'x:1', name: 'Mine' });
  assert.equal(created.statusCode, 201, 'a created resource is a 201');
  assert.equal(created.json().name, 'Mine');

  // Without a name the server fills in what it knows about the source.
  await call(h, 'POST', `${API_ROOT}/zones/3/favorites`, { uri: 'x:2' });
  await call(h, 'PATCH', `${API_ROOT}/zones/3/favorites`, { id: 1, name: 'New' });
  await call(h, 'PATCH', `${API_ROOT}/zones/3/favorites`, { order: [2, 1] });
  await call(h, 'PATCH', `${API_ROOT}/zones/3/favorites`, { play: 1 });
  await call(h, 'DELETE', `${API_ROOT}/zones/3/favorites`, { id: 1 });
  assert.deepEqual(libOps, [
    'addFav:Mine:x:1',
    'addFav:(auto):x:2',
    'renameFav:1:New',
    'reorderFav:2,1',
    'playFav:1',
    'removeFav:1',
  ]);
});

test('favourites refuse a request that says nothing', async () => {
  const h = harness();
  assert.equal((await call(h, 'POST', `${API_ROOT}/zones/3/favorites`, {})).statusCode, 400);
  assert.equal((await call(h, 'PATCH', `${API_ROOT}/zones/3/favorites`, {})).statusCode, 400);
  assert.equal((await call(h, 'DELETE', `${API_ROOT}/zones/3/favorites`, {})).statusCode, 400);
  assert.equal((await call(h, 'PATCH', `${API_ROOT}/zones/3/favorites`, { play: 42 })).statusCode, 404);
  assert.equal(libOps.filter((o) => !o.startsWith('playFav')).length, 0, 'nothing was applied');
});

test('recents read and clear, and carry no handle to edit', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/zones/3/recents`);
  assert.equal(res.statusCode, 200);
  const item = res.json().items[0];
  assert.equal(item.source, 'applemusic:track:1', 'what you hand back to play');
  assert.ok(!('id' in item), 'history has nothing to rename or reorder');

  assert.equal((await call(h, 'DELETE', `${API_ROOT}/zones/3/recents`)).statusCode, 204);
  assert.deepEqual(libOps, ['clearRecents']);
  assert.equal((await call(h, 'PUT', `${API_ROOT}/zones/3/recents`, {})).statusCode, 405);
});

test('grouping says what the group became, not just that it tried', async () => {
  const h = harness();
  const ok = await call(h, 'PUT', `${API_ROOT}/zones/3/group`, { members: [7] });
  assert.equal(ok.statusCode, 200, '200 rather than 204 — the result is worth reading');
  assert.deepEqual(ok.json(), { leader: 3, members: [3, 7], rejected: [] });

  // Grouping mirrors frames between outputs of one protocol, so a zone on another is
  // reported as rejected rather than quietly left out.
  const mixed = await call(h, 'PUT', `${API_ROOT}/zones/3/group`, { members: [7, 9] });
  assert.deepEqual(mixed.json().members, [3, 7]);
  assert.deepEqual(mixed.json().rejected, [{ id: 9, reason: 'protocol-mismatch' }]);

  const gone = await call(h, 'PUT', `${API_ROOT}/zones/3/group`, { members: [99] });
  assert.deepEqual(gone.json().rejected, [{ id: 99, reason: 'zone-not-found' }]);
});

test('an empty member list ungroups, and a bad one is refused', async () => {
  const h = harness();
  const off = await call(h, 'PUT', `${API_ROOT}/zones/3/group`, { members: [] });
  assert.equal(off.statusCode, 200);
  assert.deepEqual(off.json().members, [], 'no separate verb for leaving');

  assert.equal((await call(h, 'PUT', `${API_ROOT}/zones/3/group`, { members: 'nope' })).statusCode, 400);
  assert.equal((await call(h, 'PUT', `${API_ROOT}/zones/3/group`, {})).statusCode, 400);
  assert.equal((await call(h, 'GET', `${API_ROOT}/zones/3/group`)).statusCode, 405);
});

// A cover url that only names the zone is the point of this route: `track.coverUrl`
// changes every track and can be a remote host or a data uri, so it cannot be put in a
// wall panel's <img src> and left there.

test('the zone cover serves whatever the zone has, at a url that never changes', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/zones/3/cover`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'image/png', 'the mime the source reported');
  assert.equal(res.body, 'jpegbytes');
  // Briefly cacheable: polling should not re-fetch the same art every second, but the
  // next track has to become visible without a url change to force it.
  assert.equal(res.headers['Cache-Control'], 'public, max-age=10');
});

test('a data-uri cover is decoded rather than handed over as text', async () => {
  const h = harness();
  zoneCover = `data:image/gif;base64,${Buffer.from('gifbytes').toString('base64')}`;
  const res = await call(h, 'GET', `${API_ROOT}/zones/3/cover`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'image/gif');
  assert.equal(res.body, 'gifbytes');
  assert.equal(res.headers['Cache-Control'], 'public, max-age=10', 'same policy as bytes');
});

test('a zone without art answers 404 instead of an empty image', async () => {
  const h = harness();
  zoneCover = null;
  const res = await call(h, 'GET', `${API_ROOT}/zones/3/cover`);
  assert.equal(res.statusCode, 404);
  // An unknown zone looks the same from outside: there is no cover either way.
  assert.equal((await call(h, 'GET', `${API_ROOT}/zones/404/cover`)).statusCode, 404);
});

test('size is passed upstream as a hint, and a nonsense one falls back', async () => {
  const h = harness();
  await call(h, 'GET', `${API_ROOT}/zones/3/cover?size=300`);
  assert.deepEqual(coverAsks.at(-1), { zoneId: 3, targetSize: 300 });

  // No size, out of range, or not a number: use the now-playing default rather than
  // refusing, since the caller is usually an <img> tag that cannot handle a 400. An
  // out-of-range size must NOT be clamped to the nearest bound — this route once served
  // a 16px thumbnail to every caller that omitted `size`, because a missing value became
  // 0 and 0 clamped up to the minimum.
  for (const query of ['', '?size=0', '?size=1', '?size=99999', '?size=abc', '?size=-4']) {
    await call(h, 'GET', `${API_ROOT}/zones/3/cover${query}`);
    assert.equal(
      coverAsks.at(-1)?.targetSize,
      COVER_ART_NOW_PLAYING_SIZE,
      `${query || 'no query'} falls back`,
    );
  }
});

// The url deliberately does not change when the track does, so an ETag is what keeps a
// cached copy from going stale: revalidating costs a bodyless 304, and a new cover is
// visible immediately without the client having to change the url.

test('an unchanged cover revalidates to 304, and a new one does not', async () => {
  const h = harness();
  const first = await call(h, 'GET', `${API_ROOT}/zones/3/cover`);
  const etag = first.headers['ETag'] as string;
  assert.ok(etag, 'the response identifies which cover it carried');

  const again = await call(h, 'GET', `${API_ROOT}/zones/3/cover`, undefined, {
    'if-none-match': etag,
  });
  assert.equal(again.statusCode, 304);
  assert.equal(again.body, '', 'no body is the entire point');

  // A different track is a different tag, so the same conditional request now gets bytes.
  zoneCover = { data: Buffer.from('other-art'), mime: 'image/jpeg' };
  const changed = await call(h, 'GET', `${API_ROOT}/zones/3/cover`, undefined, {
    'if-none-match': etag,
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.body, 'other-art');
  assert.notEqual(changed.headers['ETag'], etag);
});

test('the same artwork at another size is a different tag', async () => {
  // Two sizes are two images behind one url, so sharing a tag would serve the wrong one.
  const h = harness();
  const big = await call(h, 'GET', `${API_ROOT}/zones/3/cover?size=640`);
  const small = await call(h, 'GET', `${API_ROOT}/zones/3/cover?size=300`);
  assert.notEqual(big.headers['ETag'], small.headers['ETag']);
});

test('a tag is stable across requests and identifies the source, not the request', async () => {
  // Stable means a restart or a second server hands out the same tag: it is hashed from
  // the artwork itself, not from a counter or a clock.
  const h = harness();
  const a = await call(h, 'GET', `${API_ROOT}/zones/3/cover`);
  const b = await call(harness(), 'GET', `${API_ROOT}/zones/3/cover`);
  assert.equal(a.headers['ETag'], b.headers['ETag']);
});

test('a client can bust a cache it does not control with a throwaway parameter', async () => {
  // A Loxone visualisation holds an <img src> far longer than max-age suggests, so an
  // unknown query parameter must be ignored rather than refused.
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/zones/3/cover?v=track-1234`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'jpegbytes');
  assert.equal(coverAsks.at(-1)?.targetSize, COVER_ART_NOW_PLAYING_SIZE, 'size still default');
});

test('the cover route is read-only', async () => {
  const h = harness();
  for (const method of ['PUT', 'POST', 'DELETE']) {
    assert.equal((await call(h, method, `${API_ROOT}/zones/3/cover`, {})).statusCode, 405, method);
  }
});

// A supervisor decides from the status code, so that is the part of /health and /ready
// that must not drift. The plugin's UI currently does a bare GET / and treats anything
// that is not a connection failure as healthy — a 500 passes.

test('health carries the verdict in the status code, not only the body', async () => {
  const h = harness();
  assert.equal((await call(h, 'GET', `${API_ROOT}/health`)).statusCode, 200);

  // Degraded stays 200: the commonest reaction to a non-2xx is a restart, which is wrong
  // for a server that is still playing music.
  health = { ...health, status: 'degraded', checks: [{ name: 'loxone', status: 'degraded' }] };
  const degraded = await call(h, 'GET', `${API_ROOT}/health`);
  assert.equal(degraded.statusCode, 200);
  assert.equal(degraded.json().status, 'degraded');

  health = { ...health, status: 'unhealthy' };
  assert.equal((await call(h, 'GET', `${API_ROOT}/health`)).statusCode, 503);
});

test('ready answers a yes/no a supervisor can poll cheaply', async () => {
  const h = harness();
  const ready = await call(h, 'GET', `${API_ROOT}/ready`);
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json(), { ready: true, phase: 'ready' });

  // Not ready is a 503 so a caller can branch on the code alone. This is what replaces
  // blocking 600 seconds on a file lock to guess whether a restart finished.
  lifecycle.markStarting();
  const restarting = await call(h, 'GET', `${API_ROOT}/ready`);
  assert.equal(restarting.statusCode, 503);
  assert.equal(restarting.json().ready, false);
  assert.equal(restarting.json().phase, 'starting');

  // A failed start says why, so "slow" and "broken" are distinguishable.
  lifecycle.markFailed(new Error('port 7090 already in use'));
  const failed = await call(h, 'GET', `${API_ROOT}/ready`);
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().phase, 'failed');
  assert.equal(failed.json().error, 'port 7090 already in use');
});

test('health and ready need no session and reject writes', async () => {
  const h = harness();
  for (const path of ['/health', '/ready']) {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await call(h, method, `${API_ROOT}${path}`, {});
      assert.notEqual(res.statusCode, 200, `${method} ${path} is not a command`);
    }
  }
});

// "Say in the kitchen that dinner is ready" is the thing an integrator actually wants from
// a music server, and until now only the Loxone clients could do it — spread over
// audio/<id>/tts, /alert, playeventfile and groupalert. It is a resource rather than a
// play-with-a-special-uri because an alert interrupts: the zone's own playback is ducked
// and resumed around it, and the volume comes from its alert setting, not its current one.

test('speaking into a zone passes the text and language through', async () => {
  const h = harness();
  const res = await call(h, 'POST', `${API_ROOT}/zones/3/alert`, {
    kind: 'tts',
    text: 'Dinner is ready',
    language: 'en',
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { zoneId: 3, kind: 'tts', action: 'on', zones: [3] });
  assert.equal(alertCalls.length, 1);
  assert.equal(alertCalls[0]!.text, 'Dinner is ready');
  assert.equal(alertCalls[0]!.language, 'en');
  assert.equal(alertCalls[0]!.action, 'on');
});

test('tts without text is refused rather than announcing silence', async () => {
  const h = harness();
  for (const body of [{ kind: 'tts' }, { kind: 'tts', text: '   ' }]) {
    const res = await call(h, 'POST', `${API_ROOT}/zones/3/alert`, body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.json().error, 'invalid-text');
  }
  assert.equal(alertCalls.length, 0, 'nothing reached the alerts layer');
});

test('the built-in sounds need no payload beyond their kind', async () => {
  const h = harness();
  for (const kind of ['bell', 'alarm', 'fire', 'buzzer']) {
    const res = await call(h, 'POST', `${API_ROOT}/zones/3/alert`, { kind });
    assert.equal(res.statusCode, 200, kind);
    assert.equal(res.json().kind, kind);
    assert.equal(alertCalls.at(-1)!.type, kind, 'passed through unchanged');
  }
});

test('an arbitrary sound travels as a custom url', async () => {
  // The alerts layer takes a caller-supplied sound as part of the type rather than as its
  // own argument, so the url is prefixed instead of sent separately.
  const h = harness();
  const res = await call(h, 'POST', `${API_ROOT}/zones/3/alert`, {
    kind: 'url',
    url: 'http://example/doorbell.mp3',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(alertCalls[0]!.type, 'custom_url/http://example/doorbell.mp3');

  for (const bad of ['', 'not-a-url', 'file:///etc/passwd', 'ftp://host/x.mp3']) {
    const rejected = await call(h, 'POST', `${API_ROOT}/zones/3/alert`, { kind: 'url', url: bad });
    assert.equal(rejected.statusCode, 400, bad || '(empty)');
    assert.equal(rejected.json().error, 'invalid-url');
  }
});

test('one call can announce in several zones, with the addressed one leading', async () => {
  const h = harness();
  const res = await call(h, 'POST', `${API_ROOT}/zones/3/alert`, {
    kind: 'tts',
    text: 'Everyone out',
    zones: [7, 9],
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().zones, [3, 7, 9], 'the path zone leads');
  assert.deepEqual(alertCalls[0]!.zones, [3, 7, 9]);
});

test('the addressed zone is not repeated when it is also listed', async () => {
  const h = harness();
  await call(h, 'POST', `${API_ROOT}/zones/3/alert`, { kind: 'bell', zones: [3, 7] });
  assert.deepEqual(alertCalls[0]!.zones, [3, 7]);
});

test('an alert can be stopped, which is what the looping kinds need', async () => {
  const h = harness();
  alertResult = { success: true, action: 'off' };
  const res = await call(h, 'DELETE', `${API_ROOT}/zones/3/alert`, { kind: 'alarm' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().action, 'off');
  assert.equal(alertCalls[0]!.action, 'off');
});

test('an unknown kind is refused with the list of real ones', async () => {
  const h = harness();
  const res = await call(h, 'POST', `${API_ROOT}/zones/3/alert`, { kind: 'foghorn' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid-alert-kind');
  assert.match(res.json().message, /tts/, 'says what is valid');
});

test('a volume override is optional and bounded', async () => {
  const h = harness();
  await call(h, 'POST', `${API_ROOT}/zones/3/alert`, { kind: 'bell' });
  assert.equal(alertCalls[0]!.volume, undefined, 'absent means the zone alert setting wins');

  await call(h, 'POST', `${API_ROOT}/zones/3/alert`, { kind: 'bell', volume: 80 });
  assert.equal(alertCalls[1]!.volume, 80);

  const bad = await call(h, 'POST', `${API_ROOT}/zones/3/alert`, { kind: 'bell', volume: 'loud' });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'invalid-volume');
});

test('a refusal from the alerts layer is reported, not swallowed', async () => {
  // No TTS provider configured is the common one, and a 2xx there would look like success.
  const h = harness();
  alertResult = { success: false, action: 'on', reason: 'no-tts-provider' };
  const res = await call(h, 'POST', `${API_ROOT}/zones/3/alert`, { kind: 'tts', text: 'hello' });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error, 'no-tts-provider');
});

test('an unknown zone and a wrong method are refused', async () => {
  const h = harness();
  assert.equal(
    (await call(h, 'POST', `${API_ROOT}/zones/404/alert`, { kind: 'bell' })).statusCode,
    404,
  );
  for (const method of ['GET', 'PUT', 'PATCH']) {
    const res = await call(h, method, `${API_ROOT}/zones/3/alert`, { kind: 'bell' });
    assert.equal(res.statusCode, 405, method);
  }
});

// You could already see that a zone was on a line-in but not put it there. Inputs are
// server-level — the same socket is selectable from every zone — so they are listed at the
// top level rather than under one zone, which would imply each has its own.

test('the configured inputs are listed, with what a client needs to render them', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/inputs`);
  assert.equal(res.statusCode, 200);
  const inputs = res.json().inputs;
  assert.equal(inputs.length, 2);
  // The icon is a name, not the internal Loxone number: a client would otherwise have to
  // carry that table to render anything.
  assert.equal(inputs[0].icon, 'cd-player');
  assert.equal(inputs[1].icon, 'turntable');
  // controllable says whether transport commands reach the device at all — false for a
  // turntable, where selecting it is the whole interaction.
  assert.equal(inputs[0].controllable, true);
  assert.equal(inputs[1].controllable, false);
});

test('a zone can be switched to an input', async () => {
  const h = harness();
  const res = await call(h, 'PUT', `${API_ROOT}/zones/3/input`, { input: 'linein-a' });
  assert.equal(res.statusCode, 204);
  assert.deepEqual(inputSelections, [{ zoneId: 3, inputId: 'linein-a' }]);
});

test('an unknown input is a different failure from an unknown zone', async () => {
  // A caller reading ids out of GET /inputs deserves to be told which of the two it got
  // wrong, rather than one 404 covering both.
  const h = harness();
  const badInput = await call(h, 'PUT', `${API_ROOT}/zones/3/input`, { input: 'linein-z' });
  assert.equal(badInput.statusCode, 404);
  assert.equal(badInput.json().error, 'input-not-found');

  const badZone = await call(h, 'PUT', `${API_ROOT}/zones/404/input`, { input: 'linein-a' });
  assert.equal(badZone.statusCode, 404);
  assert.equal(badZone.json().error, 'zone-not-found');
  assert.equal(inputSelections.length, 0, 'neither reached the service');
});

test('the input must actually be named', async () => {
  const h = harness();
  for (const body of [{}, { input: '' }, { input: '   ' }, { input: 7 }]) {
    const res = await call(h, 'PUT', `${API_ROOT}/zones/3/input`, body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.json().error, 'invalid-input');
  }
});

test('there is no verb for leaving an input', async () => {
  // Selecting something else is how you leave, and the server tears the old source down as
  // part of that. A DELETE would be a third way to say it with "and what plays now?" open.
  const h = harness();
  for (const method of ['GET', 'POST', 'DELETE', 'PATCH']) {
    const res = await call(h, method, `${API_ROOT}/zones/3/input`, { input: 'linein-a' });
    assert.equal(res.statusCode, 405, method);
  }
});

test('a line-in reports the id you can hand straight back, and its configured name', async () => {
  // The stored audiopath is `linein:<id>` and sourceName holds the server's MAC — neither
  // is usable by a caller, so what round-trips is the input id and the configured name.
  const api = toApiZoneState(
    zoneState({
      audiopath: 'linein:linein-a',
      audiotype: AudioType.LineIn,
      sourceName: '000C290E5497',
      duration: 0,
    }),
    { inputLabel: (id) => (id === 'linein-a' ? 'BeoSound 9000' : null) },
  );
  assert.equal(api.source?.kind, 'linein');
  assert.equal(api.source?.id, 'linein-a', 'no prefix; this is what PUT /input takes');
  assert.equal(api.source?.name, 'BeoSound 9000', 'not the MAC');
  assert.equal(api.source?.seekable, false, 'nothing to seek in a live input');
});

// A queue mutation used to emit nothing at all, so a client could not tell a queue had
// changed — including when *another* client changed it. Our own player worked around it by
// re-reading after its own edits, which left a second tab stale indefinitely. The Loxone
// protocol has carried `audio_queue_event` all along; the API tap forwarded it there and
// published nothing here.

test('a collection change reaches subscribers on our own API too', () => {
  const hub = new ApiEventHub();
  const seen: any[] = [];
  hub.subscribe((event) => seen.push(event));

  const inner = makeNotifier();
  const notifier = withApiEvents(inner as unknown as NotifierPort, hub);
  notifier.notifyQueueUpdated(3, 12);
  notifier.notifyRoomFavoritesChanged(3, 4);
  notifier.notifyRecentlyPlayedChanged(3, 1234567890);

  assert.deepEqual(seen, [
    { type: 'queue.changed', id: 3, size: 12 },
    { type: 'favorites.changed', id: 3, count: 4 },
    // The timestamp is Loxone's own change marker and says nothing a caller can use.
    { type: 'recents.changed', id: 3 },
  ]);
});

test('a collection event carries the size, never the collection', () => {
  // A queue is paged and can hold thousands of entries; putting it in an event that fires on
  // every edit would be the wrong trade.
  const hub = new ApiEventHub();
  const seen: any[] = [];
  hub.subscribe((event) => seen.push(event));
  withApiEvents(makeNotifier() as unknown as NotifierPort, hub).notifyQueueUpdated(3, 900);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['id', 'size', 'type']);
});

test('Loxone still gets its own event, whatever happens on our side', () => {
  // The public API must never be able to break Loxone delivery, so the inner notifier is
  // called first and a subscriber that throws cannot stop it.
  const hub = new ApiEventHub();
  hub.subscribe(() => {
    throw new Error('subscriber is broken');
  });
  const inner = makeNotifier();
  const notifier = withApiEvents(inner as unknown as NotifierPort, hub);
  notifier.notifyQueueUpdated(3, 1);
  assert.deepEqual(inner.queue, [{ zoneId: 3, size: 1 }], 'Loxone was told regardless');
});

test('identical collection events are both delivered', () => {
  // Unlike zone state, which is a value worth deduplicating, "the queue changed" is an
  // event: two identical ones mean it changed twice. A reorder keeps the size and must
  // still be reported.
  const hub = new ApiEventHub();
  const seen: any[] = [];
  hub.subscribe((event) => seen.push(event));
  const notifier = withApiEvents(makeNotifier() as unknown as NotifierPort, hub);
  notifier.notifyQueueUpdated(3, 5);
  notifier.notifyQueueUpdated(3, 5);
  assert.equal(seen.length, 2);
});

function makeNotifier() {
  const queue: Array<{ zoneId: number; size: number }> = [];
  return {
    queue,
    notifyZoneStateChanged: () => {},
    notifyQueueUpdated: (zoneId: number, size: number) => queue.push({ zoneId, size }),
    notifyRoomFavoritesChanged: () => {},
    notifyRecentlyPlayedChanged: () => {},
    notifyRescan: () => {},
    notifyReloadMusicApp: () => {},
    notifyGlobalSearchResult: () => {},
    notifyGlobalSearchError: () => {},
    notifyAlertStateChanged: () => {},
    notifyPlaylistsChanged: () => {},
    notifyRadiosChanged: () => {},
    notifyServiceChanged: () => {},
  };
}

// `POST /play` answers 204 for a uri it cannot resolve, because resolution is asynchronous —
// the call is accepted before anything is looked up. So the failure has to surface in state,
// and it used to do so only as prose in `track.title`: `if (zone.track)` was then true for a
// zone playing nothing, and a UI rendered an error as a song title. Our own player had to run
// verification timers because of it.

test('a failed play reports an error, not a track', () => {
  // The signature a failure leaves: stopped, a user-facing title, and nothing loaded.
  const api = toApiZoneState(
    zoneState({
      mode: 'stop',
      title: 'Playback unavailable',
      artist: '',
      album: '',
      audiopath: '',
      duration: 0,
      time: 0,
    }),
  );
  assert.equal(api.error, 'Playback unavailable');
  assert.equal(api.track, null, 'if (zone.track) must not be true for a zone playing nothing');
  assert.equal(api.source, null);
});

test('a real track is never mistaken for an error', () => {
  const api = toApiZoneState(zoneState({ mode: 'play' }));
  assert.ok(!('error' in api), 'absent, so `if (zone.error)` is the whole check');
  assert.equal(api.track?.title, 'Song');
});

test('a stopped zone with a real track loaded is not an error', () => {
  // Stopping after playing something leaves the track in place; only a cleared zone with a
  // lone title is a failure.
  const api = toApiZoneState(zoneState({ mode: 'stop' }));
  assert.ok(!('error' in api));
  assert.equal(api.track?.title, 'Song');
});

test('an idle zone reports neither a track nor an error', () => {
  const api = toApiZoneState(
    zoneState({ mode: 'stop', title: '', artist: '', album: '', audiopath: '' }),
  );
  assert.equal(api.track, null);
  assert.ok(!('error' in api));
});
