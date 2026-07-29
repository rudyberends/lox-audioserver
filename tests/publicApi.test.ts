import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import { ApiHandler } from '../src/adapters/http/api/apiHandler';
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
    ...overrides,
  } as ZoneState;
}

type Harness = {
  handler: ApiHandler;
  hub: ApiEventHub;
  commands: Array<{ zoneId: number; command: string; payload?: string }>;
  states: Map<number, ZoneState>;
};

let eqBands: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

function harness(): Harness {
  eqBands = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const states = new Map<number, ZoneState>([[3, zoneState()]]);
  const commands: Harness['commands'] = [];
  const hub = new ApiEventHub();
  const handler = new ApiHandler({
    eventHub: hub,
    getAllZoneStates: () => [...states.values()],
    getZoneState: (zoneId) => states.get(zoneId) ?? null,
    handleCommand: (zoneId, command, payload) => commands.push({ zoneId, command, payload }),
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
  return { handler, hub, commands, states };
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
  const res = await call(h, 'GET', '/api/zones');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().zones.length, 1);
  assert.equal(res.json().zones[0].name, 'Kitchen');
});

test('GET /api/zones/{id} 404s for an unknown zone', async () => {
  const h = harness();
  const res = await call(h, 'GET', '/api/zones/99');
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
    const res = await call(h, 'POST', `/api/zones/3/${route}`);
    assert.equal(res.statusCode, 204, `${route} should return 204`);
    assert.equal(h.commands.at(-1)?.command, expected);
    assert.equal(h.commands.at(-1)?.zoneId, 3);
  }
});

test('volume accepts an absolute value and a signed delta', async () => {
  const h = harness();
  await call(h, 'PUT', '/api/zones/3/volume', { volume: 55 });
  assert.deepEqual(h.commands.at(-1), { zoneId: 3, command: 'volume', payload: '55' });

  // Relative stepping is how every physical remote works; a read-then-write
  // client would race with itself.
  await call(h, 'PUT', '/api/zones/3/volume', { delta: -5 });
  assert.equal(h.commands.at(-1)?.payload, '-5');
  await call(h, 'PUT', '/api/zones/3/volume', { delta: 5 });
  assert.equal(h.commands.at(-1)?.payload, '+5');
});

test('volume clamps to the documented 0-100 range', async () => {
  const h = harness();
  await call(h, 'PUT', '/api/zones/3/volume', { volume: 500 });
  assert.equal(h.commands.at(-1)?.payload, '100');
  await call(h, 'PUT', '/api/zones/3/volume', { volume: -20 });
  assert.equal(h.commands.at(-1)?.payload, '0');
});

test('malformed command bodies are rejected without reaching the engine', async () => {
  const h = harness();
  for (const body of [{ volume: 'loud' }, {}]) {
    const res = await call(h, 'PUT', '/api/zones/3/volume', body);
    assert.equal(res.statusCode, 400);
  }
  const bad = await call(h, 'PUT', '/api/zones/3/power', { power: 'maybe' });
  assert.equal(bad.statusCode, 400);
  assert.equal(h.commands.length, 0, 'no invalid request may reach the zone engine');
});

test('a wrong method is a 405, not a silent success', async () => {
  const h = harness();
  const res = await call(h, 'GET', '/api/zones/3/volume');
  assert.equal(res.statusCode, 405);
  assert.equal(h.commands.length, 0);
});

test('GET /api/health reports status, version and uptime', async () => {
  const h = harness();
  const res = await call(h, 'GET', '/api/health');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
  assert.equal(res.json().version, '4.0.0-test');
  assert.ok(res.json().uptimeSec >= 5);
});

test('the events stream opens with a full snapshot so clients render immediately', async () => {
  const h = harness();
  const res = new FakeResponse();
  await h.handler.handle(
    makeRequest('GET', '/api/events'),
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
  await h.handler.handle(makeRequest('GET', '/api/events'), res as unknown as ServerResponse);
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
  const req = makeRequest('GET', '/api/events');
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
  const before = await call(h, 'GET', '/api/zones/3/equalizer');
  assert.equal(before.statusCode, 200);
  assert.deepEqual(before.json().bands, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

  // The exact body the plugin sends.
  const put = await call(h, 'PUT', '/api/zones/3/equalizer', {
    bands: [6, 6, 6, 6, 6, 6, 6, 0, -2, 2],
  });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json().bands, [6, 6, 6, 6, 6, 6, 6, 0, -2, 2]);

  const after = await call(h, 'GET', '/api/zones/3/equalizer');
  assert.deepEqual(after.json().bands, [6, 6, 6, 6, 6, 6, 6, 0, -2, 2]);
});

test('equalizer is readable without live playback state', async () => {
  // It is configuration, not playback, so it must not require a zone that is
  // currently streaming — an idle zone still has an equalizer to configure.
  const h = harness();
  h.states.clear();
  const res = await call(h, 'GET', '/api/zones/3/equalizer');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().zoneId, 3);
});

test('equalizer rejects a band array that is not ten values', async () => {
  const h = harness();
  for (const bands of [[1, 2], new Array(11).fill(0), 'loud', null]) {
    const res = await call(h, 'PUT', '/api/zones/3/equalizer', { bands });
    assert.equal(res.statusCode, 400, `rejects ${JSON.stringify(bands)}`);
    assert.equal(res.json().error, 'invalid-equalizer-bands');
  }
  // And nothing was applied.
  const after = await call(h, 'GET', '/api/zones/3/equalizer');
  assert.deepEqual(after.json().bands, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('equalizer 404s an unknown zone and 405s a wrong method', async () => {
  const h = harness();
  assert.equal((await call(h, 'GET', '/api/zones/99/equalizer')).statusCode, 404);
  assert.equal((await call(h, 'POST', '/api/zones/3/equalizer')).statusCode, 405);
});
