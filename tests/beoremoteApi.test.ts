import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import { BeoremoteApiHandler } from '../src/adapters/http/beoremote/beoremoteApiHandler';

// The bridge is a separate process on the LAN, so this API is a trust boundary as
// much as a convenience: it must never hand out audiopaths, and it must reject a
// pick made against a menu that has since moved rather than start the wrong source.

class FakeResponse extends EventEmitter {
  public statusCode: number | null = null;
  public body = '';
  public writableEnded = false;

  public writeHead(status: number): this {
    this.statusCode = status;
    return this;
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

function request(method: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const stream = Readable.from(payload ? [Buffer.from(payload)] : []) as unknown as IncomingMessage;
  (stream as any).method = method;
  (stream as any).headers = {};
  (stream as any).socket = { destroyed: true, destroy: () => {} };
  return stream;
}

type Played = { zoneId: number; audiopath: string; type: string };

function createHarness(options: {
  enabled?: boolean;
  favorites?: Array<{ id: number; slot: number; name: string; audiopath: string }>;
  radios?: Array<{ cmd: string; name: string; root: string }>;
  stations?: Array<{ id: string; name: string; audiopath: string }>;
  audiopath?: string;
  submenuSource?: unknown;
  lineIns?: Array<{ id: string; name: string; iconType: number; index: number }>;
} = {}) {
  const played: Played[] = [];
  const activatedLineIns: Array<{ zoneId: number; inputId: string }> = [];
  const sentCommands: Array<{ inputId: string; command: string; args: string[] }> = [];
  const commands: Array<{ zoneId: number; command: string }> = [];
  const zoneAudiopath = { value: options.audiopath ?? '' };
  // A zone owns its remote: enabling it there is what turns the integration on.
  const config: any = {
    zones: [
      {
        id: 12,
        name: 'Living',
        inputs: {
          beoremote: {
            enabled: options.enabled !== false,
            submenuSource: options.submenuSource ?? { kind: 'radio' },
          },
        },
      },
    ],
  };
  const handler = new BeoremoteApiHandler({
    configPort: {
      getConfig: () => config,
      updateConfig: async (mutate: (cfg: any) => void) => {
        mutate(config);
      },
    } as any,
    favorites: {
      get: async () => ({
        items: (options.favorites ?? [
          { id: 1, slot: 0, name: 'Jazz Mix', audiopath: 'spotify:playlist:42' },
          { id: 2, slot: 1, name: 'Morning', audiopath: 'spotify:playlist:7' },
        ]).map((fav) => ({ ...fav, plus: true, type: 11 })),
      }),
      getAudiopathForFavorite: async (_zoneId: number, slot: number) =>
        slot === 1 ? 'spotify:playlist:42' : null,
    } as any,
    contentManager: {
      // The real roots are folders ("TuneIn Presets"), not stations — the menu
      // builder opens them and splices their contents into one flat list.
      getRadios: async () => options.radios ?? [{ cmd: 'local', name: 'TuneIn Presets', root: 'start', icon: '' }],
      getServiceFolder: async (service: string) => {
        const byService: Record<string, Array<{ id: string; name: string; audiopath: string }>> = {
          local: [
            { id: 's1', name: 'NPO Radio 2', audiopath: 'tunein:station:npo2' },
            { id: 's2', name: 'RTV Noord', audiopath: 'tunein:station:noord' },
          ],
        };
        const items = options.stations ?? byService[service] ?? [];
        return { id: 'start', name: service, start: 0, totalitems: items.length, items };
      },
    } as any,
    zoneManager: {
      playContent: async (zoneId: number, audiopath: string, type: string) => {
        played.push({ zoneId, audiopath, type });
      },
      handleCommand: (zoneId: number, command: string) => {
        commands.push({ zoneId, command });
      },
      getZoneState: () => ({ audiopath: zoneAudiopath.value }),
    } as any,
    lineIn: {
      listLineInInputs: () => options.lineIns ?? [],
      activateLineIn: (zoneId: number, inputId: string) => {
        activatedLineIns.push({ zoneId, inputId });
      },
      sendCommand: (inputId: string, command: string, args: string[] = []) => {
        sentCommands.push({ inputId, command, args });
      },
    } as any,
  });
  return { handler, played, config, activatedLineIns, sentCommands, commands, zoneAudiopath };
}

async function call(
  handler: BeoremoteApiHandler,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<FakeResponse> {
  const res = new FakeResponse();
  await handler.handle(request(method, body), res as unknown as ServerResponse, pathname);
  return res;
}

test('the menu lists the submenu owner first, then favorites in slot order', async () => {
  const { handler } = createHarness();
  const res = await call(handler, 'GET', '/api/beoremote/zones/12/menu');
  assert.equal(res.statusCode, 200);
  const menu = res.json();
  assert.deepEqual(menu.sources.map((entry: any) => entry.name), ['Radio', 'Jazz Mix', 'Morning']);
  assert.equal(menu.sources[0].submenu, true);
  assert.deepEqual(menu.submenu.map((entry: any) => entry.name), ['NPO Radio 2', 'RTV Noord']);
});

test('the published menu never carries an audiopath', async () => {
  const { handler } = createHarness();
  const res = await call(handler, 'GET', '/api/beoremote/zones/12/menu');
  // The bridge reports a position; giving it paths would let anything that can
  // reach this port ask the server to play arbitrary content.
  assert.equal(res.body.includes('spotify:playlist'), false);
  assert.equal(res.body.includes('radio:npo2'), false);
});

test('selecting a favorite starts it on the zone', async () => {
  const { handler, played } = createHarness();
  const menu = (await call(handler, 'GET', '/api/beoremote/zones/12/menu')).json();
  const res = await call(handler, 'POST', '/api/beoremote/zones/12/select', {
    list: 'source',
    index: 1,
    revision: menu.revision,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(played, [{ zoneId: 12, audiopath: 'spotify:playlist:42', type: 'favorite' }]);
});

test('selecting a submenu station starts it', async () => {
  const { handler, played } = createHarness();
  const menu = (await call(handler, 'GET', '/api/beoremote/zones/12/menu')).json();
  await call(handler, 'POST', '/api/beoremote/zones/12/select', {
    list: 'submenu',
    index: 1,
    revision: menu.revision,
  });
  assert.deepEqual(played, [{ zoneId: 12, audiopath: 'tunein:station:noord', type: 'serviceplay' }]);
});

test('the radio submenu holds stations, not the folders they live in', async () => {
  const { handler } = createHarness();
  const menu = (await call(handler, 'GET', '/api/beoremote/zones/12/menu')).json();
  // The remote cannot browse into anything, so a folder row would be a dead end.
  assert.deepEqual(menu.submenu.map((e: any) => e.name), ['NPO Radio 2', 'RTV Noord']);
  assert.equal(menu.submenu.some((e: any) => e.name === 'TuneIn Presets'), false);
});

test('stations from several roots are spliced into one flat list', async () => {
  const { handler } = createHarness({
    radios: [
      { cmd: 'local', name: 'TuneIn Presets', root: 'start' },
      { cmd: 'custom', name: 'Custom Streams', root: 'start' },
    ],
    stations: [{ id: 's1', name: 'BBC Radio 1', audiopath: 'tunein:station:bbc1' }],
  });
  const menu = (await call(handler, 'GET', '/api/beoremote/zones/12/menu')).json();
  // Both roots return the same station here; the duplicate must collapse.
  assert.deepEqual(menu.submenu.map((e: any) => e.name), ['BBC Radio 1']);
});

test('a pick against a moved menu is rejected with 409, not misresolved', async () => {
  const { handler, played, config } = createHarness();
  const menu = (await call(handler, 'GET', '/api/beoremote/zones/12/menu')).json();

  // The zone's submenu setting changes between reading the menu and pressing select.
  config.zones[0].inputs.beoremote.submenuSource = { kind: 'none' };

  const res = await call(handler, 'POST', '/api/beoremote/zones/12/select', {
    list: 'source',
    index: 0,
    revision: menu.revision,
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'stale-revision');
  // The current revision comes back so the bridge can resync without a second call.
  assert.ok(res.json().revision);
  assert.deepEqual(played, [], 'nothing may start when the list moved');
});

test('selecting the submenu owner does nothing — it is a heading', async () => {
  const { handler, played } = createHarness();
  const menu = (await call(handler, 'GET', '/api/beoremote/zones/12/menu')).json();
  const res = await call(handler, 'POST', '/api/beoremote/zones/12/select', {
    list: 'source',
    index: 0,
    revision: menu.revision,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'not-selectable');
  assert.deepEqual(played, []);
});

test('a raw ACTIVE_SOURCE value is accepted in place of an index', async () => {
  const { handler, played } = createHarness();
  const menu = (await call(handler, 'GET', '/api/beoremote/zones/12/menu')).json();
  // 20 + 1 = the second entry; a bridge may pass the protocol value straight through.
  await call(handler, 'POST', '/api/beoremote/zones/12/select', {
    list: 'source',
    active_source: 21,
    revision: menu.revision,
  });
  assert.deepEqual(played, [{ zoneId: 12, audiopath: 'spotify:playlist:42', type: 'favorite' }]);
});

test('a selection without a revision is refused', async () => {
  const { handler, played } = createHarness();
  const res = await call(handler, 'POST', '/api/beoremote/zones/12/select', { list: 'source', index: 1 });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'missing-revision');
  assert.deepEqual(played, []);
});

test('an unknown zone answers 404', async () => {
  const { handler } = createHarness();
  const res = await call(handler, 'GET', '/api/beoremote/zones/99/menu');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'zone-not-found');
});

test('a zone that never turned its remote on is not reachable', async () => {
  const { handler, config } = createHarness();
  // Zone 13 exists but did not opt in, so a misaimed bridge cannot drive it.
  config.zones.push({ id: 13, name: 'Kitchen', inputs: {} });
  const res = await call(handler, 'GET', '/api/beoremote/zones/13/menu');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'zone-not-found');
});



test('the whole namespace is closed when the integration is disabled', async () => {
  const { handler } = createHarness({ enabled: false });
  for (const path of ['/api/beoremote/zones/12/menu', '/api/beoremote/bridges']) {
    const res = await call(handler, 'GET', path);
    assert.equal(res.statusCode, 404, path);
    assert.equal(res.json().error, 'beoremote-disabled');
  }
});




test('GET on a select route is refused rather than treated as a pick', async () => {
  const { handler } = createHarness();
  const res = await call(handler, 'GET', '/api/beoremote/zones/12/select');
  assert.equal(res.statusCode, 405);
});

test('an unknown path under the namespace is a 404', async () => {
  const { handler } = createHarness();
  const res = await call(handler, 'GET', '/api/beoremote/nonsense');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'not-found');
});

test('line-ins appear as sources, before the volatile favorites', async () => {
  const { handler } = createHarness({
    lineIns: [
      { id: 'in-1', name: 'BeoSound 9000', iconType: 0, index: 0 },
      { id: 'in-2', name: 'Turntable', iconType: 7, index: 1 },
    ],
  });
  const menu = (await call(handler, 'GET', '/api/beoremote/zones/12/menu')).json();
  // Physical inputs keep stable positions; favorites come and go, so they go last.
  assert.deepEqual(menu.sources.map((e: any) => e.name), [
    'Radio',
    'BeoSound 9000',
    'Turntable',
    'Jazz Mix',
    'Morning',
  ]);
});

test('selecting a line-in activates it on the zone', async () => {
  const { handler, activatedLineIns, played } = createHarness({
    lineIns: [{ id: 'in-1', name: 'BeoSound 9000', iconType: 0, index: 0 }],
  });
  const menu = (await call(handler, 'GET', '/api/beoremote/zones/12/menu')).json();
  const res = await call(handler, 'POST', '/api/beoremote/zones/12/select', {
    list: 'source',
    index: 1,
    revision: menu.revision,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(activatedLineIns, [{ zoneId: 12, inputId: 'in-1' }]);
  assert.deepEqual(played, [], 'a line-in is activated, not played as content');
});

test('a zone can leave line-ins out of its remote menu', async () => {
  const { handler, config } = createHarness({
    lineIns: [{ id: 'in-1', name: 'BeoSound 9000', iconType: 0, index: 0 }],
  });
  config.zones[0].inputs.beoremote.includeLineIns = false;
  const menu = (await call(handler, 'GET', '/api/beoremote/zones/12/menu')).json();
  assert.equal(menu.sources.some((e: any) => e.name === 'BeoSound 9000'), false);
});

test('a transport key goes through the existing routing, not around it', async () => {
  const { handler, commands } = createHarness();
  const res = await call(handler, 'POST', '/api/beoremote/zones/12/key', { code: '0xb5' });
  assert.equal(res.statusCode, 200);
  // handleCommand is what already decides line-in-bridge vs local queue; the key
  // API must not duplicate that decision.
  assert.deepEqual(commands, [{ zoneId: 12, command: 'next' }]);
});

test('a digit key selects a disc on the line-in the zone is playing', async () => {
  const { handler, sentCommands } = createHarness({ audiopath: 'linein://in-1' });
  const res = await call(handler, 'POST', '/api/beoremote/zones/12/key', { code: '0x08' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(sentCommands, [{ inputId: 'in-1', command: 'disc', args: ['3'] }]);
});

test('a digit key on a network source is refused rather than sent nowhere', async () => {
  const { handler, sentCommands } = createHarness({ audiopath: 'spotify:track:x' });
  const res = await call(handler, 'POST', '/api/beoremote/zones/12/key', { code: '0x08' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'not-a-line-in-source');
  assert.deepEqual(sentCommands, []);
});

test('a colour key starts the matching favorite', async () => {
  const { handler, played } = createHarness();
  const res = await call(handler, 'POST', '/api/beoremote/zones/12/key', { code: '0x01' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(played, [{ zoneId: 12, audiopath: 'spotify:playlist:42', type: 'favorite' }]);
});

test('a colour key for an empty favorite slot reports it instead of failing silently', async () => {
  const { handler, played } = createHarness();
  const res = await call(handler, 'POST', '/api/beoremote/zones/12/key', { code: '0x04' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'favorite-empty');
  assert.deepEqual(played, []);
});

test('an unassigned code answers 404 so the bridge can log it', async () => {
  const { handler } = createHarness();
  const res = await call(handler, 'POST', '/api/beoremote/zones/12/key', { code: '0x7f' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'key-not-assigned');
  assert.equal(res.json().code, '0x7f');
});

test('a known-but-unbound key names the button in its 404', async () => {
  const { handler } = createHarness();
  const res = await call(handler, 'POST', '/api/beoremote/zones/12/key', { code: '0x41' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().button, 'nav-41');
});

test('a key needs no revision — nothing can shift under a button', async () => {
  const { handler, commands } = createHarness();
  const res = await call(handler, 'POST', '/api/beoremote/zones/12/key', { code: '0xb0' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(commands, [{ zoneId: 12, command: 'play' }]);
});

test('a malformed code is rejected', async () => {
  const { handler } = createHarness();
  const res = await call(handler, 'POST', '/api/beoremote/zones/12/key', { code: 'nope' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid-code');
});

test('a zone with no submenu configured publishes only its favorites', async () => {
  const { handler } = createHarness({ submenuSource: { kind: 'none' } });
  const menu = (await call(handler, 'GET', '/api/beoremote/zones/12/menu')).json();
  assert.deepEqual(menu.sources.map((e: any) => e.name), ['Jazz Mix', 'Morning']);
  assert.deepEqual(menu.submenu, []);
  assert.equal(menu.sources.some((e: any) => e.submenu), false);
});
