import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { test } from './testHarness';
import { buildZonesRoutes } from '../src/adapters/http/adminApi/zones/zonesHandlers';
import { AudioType, FileType } from '../src/domain/zones/enums';

// /admin/api/zones/states is diagnostics for our own Admin UI. It used to double as
// a now-playing feed, which is why third parties polled it; that job belongs to
// /api/zones now. These tests keep the metadata from creeping back.

class FakeResponse extends EventEmitter {
  public statusCode: number | null = null;
  public body = '';

  public writeHead(status: number): this {
    this.statusCode = status;
    return this;
  }

  public end(data?: string): void {
    if (data !== undefined) this.body += data;
    this.emit('finish');
  }
}

function deps(mode: 'play' | 'pause' | 'stop' | null) {
  const state =
    mode === null
      ? undefined
      : ({
          id: 3,
          name: 'Kitchen',
          mode,
          title: 'Song',
          artist: 'Artist',
          album: 'Album',
          station: 'Radio Paradise',
          sourceName: 'Library',
          coverurl: 'http://cover/art.jpg',
          audiopath: 'library://track/9',
          audiotype: AudioType.File,
          type: FileType.File,
          volume: 40,
        } as any);
  const sent: { status?: number; body?: any } = {};
  return {
    sent,
    deps: {
      log: { warn: () => {}, info: () => {}, debug: () => {} },
      configPort: { getConfig: () => ({ zones: [{ id: 3, name: 'Kitchen' }] }) },
      audioManager: { getSession: () => undefined, getStreamStats: () => [] },
      // Production always returns settings, falling back to defaults — never undefined.
      zoneAudioPrefs: {
        getEffectiveOutputSettings: () => ({
          sampleRate: 44100,
          channels: 2,
          mp3Bitrate: '320k',
          pcmBitDepth: 16,
          httpProfile: 'mp3',
          httpIcyEnabled: false,
          httpIcyInterval: 0,
          httpIcyName: '',
          prebufferBytes: 0,
          httpFallbackSeconds: 0,
        }),
      },
      zoneManager: {
        getState: () => state,
        getTechnicalSnapshot: () => ({ activeOutput: 'sendspin', transports: ['sendspin'] }),
      },
      favoritesManager: {},
      recentsManager: {},
      getClockOffsetMs: async () => 0,
      readJsonBody: async () => null,
      sendJson: (_res: ServerResponse, status: number, body: unknown) => {
        sent.status = status;
        sent.body = body;
      },
    } as any,
  };
}

async function fetchStates(mode: 'play' | 'pause' | 'stop' | null) {
  const { sent, deps: d } = deps(mode);
  const route = buildZonesRoutes(d).find(
    (r) => r.method === 'GET' && r.pattern.source === /^\/zones\/states$/.source,
  );
  assert.ok(route, 'zones/states route exists');
  await route!.handler({} as any, new FakeResponse() as unknown as ServerResponse, [] as any);
  return sent;
}

test('admin zone states carries no now-playing metadata', async () => {
  const sent = await fetchStates('play');
  assert.equal(sent.status, 200);
  const zone = sent.body.zones[0];

  for (const gone of ['title', 'artist', 'album', 'station', 'sourceName', 'coverurl', 'coverUrl']) {
    assert.ok(!(gone in zone), `diagnostics must not carry ${gone} — that is /api/zones`);
  }
  // And nothing may leak it in a nested shape either.
  const json = JSON.stringify(sent.body);
  assert.ok(!json.includes('Radio Paradise'), 'no station name anywhere');
  assert.ok(!json.includes('http://cover/art.jpg'), 'no cover url anywhere');
});

test('admin zone states keeps what the Zones cards actually need', async () => {
  const sent = await fetchStates('play');
  const zone = sent.body.zones[0];
  assert.equal(zone.id, 3);
  assert.equal(zone.name, 'Kitchen');
  assert.ok('tech' in zone, 'the diagnostics payload itself');
  assert.ok('transports' in zone);
  assert.ok(sent.body.system, 'host stats for the dashboard');
});

test('admin zone states reports playback in the same words as /api/zones', async () => {
  // The card only needs "is it playing", but it should not learn a second
  // vocabulary for it — this used to ship the internal 'play'/'pause' spelling.
  assert.equal((await fetchStates('play')).body.zones[0].state, 'playing');
  assert.equal((await fetchStates('pause')).body.zones[0].state, 'paused');
  assert.equal((await fetchStates('stop')).body.zones[0].state, 'stopped');
});

test('admin zone states reports a zone with no live state as stopped', async () => {
  const sent = await fetchStates(null);
  assert.equal(sent.body.zones[0].state, 'stopped');
});

test('state-controllers serves the picker its options, with a stable shape', async () => {
  // The Admin UI renders its state-controller picker from this, instead of keeping a
  // second copy of the list. So each entry needs an id to submit and a label to show;
  // adding a controller server-side must be enough to make it appear.
  const { sent, deps: d } = deps('play');
  const route = buildZonesRoutes(d).find(
    (r) => r.pattern.source === /^\/zones\/state-controllers$/.source,
  );
  assert.ok(route, 'route exists');
  await route!.handler({} as any, new FakeResponse() as unknown as ServerResponse, [] as any);

  assert.equal(sent.status, 200);
  const list = sent.body.stateControllers;
  assert.ok(Array.isArray(list) && list.length > 0);
  for (const entry of list) {
    assert.equal(typeof entry.id, 'string', 'id is what the UI submits');
    assert.ok(entry.id.length > 0);
    assert.equal(typeof entry.label, 'string', 'label is the fallback when untranslated');
    assert.ok(entry.label.length > 0);
  }
  assert.ok(
    list.some((e: { id: string }) => e.id === 'internal'),
    'internal is the default a zone falls back to',
  );
});

test('admin zone states no longer carries squeezelite player identity', async () => {
  // It moved to /api as `output.device` (sonn-audio/core#247). Nothing of ours read it
  // here, and leaving it would keep integrators pointed at /admin/api.
  const sent = await fetchStates('play');
  const json = JSON.stringify(sent.body);
  assert.ok(!json.includes('"player"'), 'no player identity in the diagnostics payload');
});

test('an idle zone still reports its configured transports', async () => {
  // The `tech` block used to appear only when there was a session, a playback source,
  // or a matching squeezelite player — so an idle Sonos or Cast zone reported nothing
  // while an idle squeezelite one did. It keys on the technical snapshot now.
  const sent = await fetchStates(null);
  const zone = sent.body.zones[0];
  assert.ok(zone.tech, 'tech is present without a live session');
  assert.deepEqual(zone.tech.transports, ['sendspin']);
  assert.equal(zone.tech.outputTarget, 'sendspin', 'the Zones card reads this for the device name');
});
