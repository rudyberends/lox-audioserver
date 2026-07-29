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

function makeRequest(method: string, url: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const stream = Readable.from(payload ? [payload] : []) as unknown as IncomingMessage;
  (stream as any).method = method;
  (stream as any).url = url;
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

function harness(): Harness {
  eqBands = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
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
    serverVersion: '4.0.0-test',
    startedAt: Date.now() - 5000,
  });
  return { handler, hub, commands, plays, states };
}

async function call(h: Harness, method: string, url: string, body?: unknown) {
  const res = new FakeResponse();
  await h.handler.handle(makeRequest(method, url, body), res as unknown as ServerResponse);
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
  assert.equal(api.repeat, 'all');
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
