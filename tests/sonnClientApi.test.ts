import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import { SonnClientApiHandler } from '../src/adapters/http/sonnClientApi/sonnClientApiHandler';
import { buildSonnClientRoutes } from '../src/adapters/http/adminApi/sonnclients/sonnClientAdminHandlers';

// A speaker running Sonn Client holds no settings of its own: it reports what hardware it has and
// this API answers with what it should be. Two properties matter most and are easy to break —
// every reply carries the *full* desired state (so a UI change lands one poll later without the
// server reaching back in), and a device that a zone still points at cannot be forgotten out from
// under it.

class FakeResponse extends EventEmitter {
  public statusCode: number | null = null;
  public body = '';

  public writeHead(status: number): this {
    this.statusCode = status;
    return this;
  }

  public end(data?: string | Buffer): void {
    if (data !== undefined) this.body += data.toString();
    this.emit('finish');
  }

  public json(): any {
    return this.body ? JSON.parse(this.body) : null;
  }
}

function request(method: string, body?: unknown, host = 'audioserver.local:7090'): IncomingMessage {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const stream = Readable.from(payload ? [Buffer.from(payload)] : []) as unknown as IncomingMessage;
  (stream as any).method = method;
  (stream as any).headers = { host };
  return stream;
}

function createHarness(initial: any = {}) {
  const { lineInActivation, ...rest } = initial;
  const config: any = {
    system: { audioserver: { ip: '192.168.1.209', name: 'Audioserver' } },
    zones: [],
    inputs: {},
    ...rest,
  };
  const configPort: any = {
    getConfig: () => config,
    updateConfig: async (mutate: (cfg: any) => void | Promise<void>) => {
      await mutate(config);
      return config;
    },
  };
  const handler = new SonnClientApiHandler(configPort, 7090, lineInActivation);
  const log: any = { info: () => {}, warn: () => {}, debug: () => {}, spam: () => {} };
  const routes = buildSonnClientRoutes({
    log,
    configPort,
    sonnClientApi: handler,
    readJsonBody: async (req) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req as any) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString('utf8');
      return raw ? JSON.parse(raw) : null;
    },
    sendJson: (res, status, body) => {
      res.writeHead(status);
      res.end(JSON.stringify(body));
    },
  });

  const call = async (
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<FakeResponse> => {
    const res = new FakeResponse();
    await handler.handle(request(method, body), res as unknown as ServerResponse, pathname);
    return res;
  };

  const admin = async (method: string, path: string, body?: unknown): Promise<FakeResponse> => {
    const route = routes.find((entry) => entry.method === method && entry.pattern.test(path));
    assert.ok(route, `no admin route for ${method} ${path}`);
    const res = new FakeResponse();
    const match = path.match(route!.pattern)!;
    await route!.handler(request(method, body), res as unknown as ServerResponse, match);
    return res;
  };

  return { config, handler, call, admin };
}

const REGISTRATION = {
  device_id: 'sonn-kitchen-9e2f',
  agent: 'sonn-client',
  version: '0.1.0',
  hostname: 'kitchen-pi',
  ip: '192.168.1.42',
  mac: 'DC:A6:32:1B:44:90',
  model: 'Raspberry Pi 4 Model B',
  arch: 'aarch64',
  outputs: [
    { id: 'hw:CARD=DAC,DEV=0', name: 'Topping E30', channels: 2, is_default: false },
    { id: 'default', name: 'Default', channels: 2, is_default: true },
  ],
  inputs: [{ id: 'hw:CARD=CODEC,DEV=0', name: 'USB Codec', channels: 2, is_default: true }],
  capabilities: { codecs: ['flac', 'pcm'], max_players: 4, features: ['source'] },
};

test('a device that registers appears in the config without being given anything to play', async () => {
  const { config, call } = createHarness();

  const res = await call('POST', '/api/sonnclients/register', REGISTRATION);
  assert.equal(res.statusCode, 200);
  const desired = res.json();
  // It has a server and a poll interval, and nothing to do: this is what "waiting to be given a
  // room" looks like from the device's side.
  assert.equal(desired.sendspin_url, 'ws://audioserver.local:7090/sendspin');
  assert.equal(desired.poll_interval_ms, 5000);
  assert.deepEqual(desired.players, []);
  assert.deepEqual(desired.sources, []);

  const stored = config.sonnClients.devices;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].deviceId, 'sonn-kitchen-9e2f');
  assert.equal(stored[0].hostname, 'kitchen-pi');
  assert.equal(stored[0].model, 'Raspberry Pi 4 Model B');
  // Identity only. Nothing here decides which card it plays through.
  assert.equal(stored[0].players, undefined);
});

test('the sendspin url comes from the host the device actually reached us on', async () => {
  const { handler } = createHarness();
  const res = new FakeResponse();
  // A machine with several interfaces would otherwise be told to dial the wrong one.
  await handler.handle(
    request('POST', REGISTRATION, '10.0.0.5:7090'),
    res as unknown as ServerResponse,
    '/api/sonnclients/register',
  );
  assert.equal(res.json().sendspin_url, 'ws://10.0.0.5:7090/sendspin');

  const withoutHost = new FakeResponse();
  await handler.handle(
    request('POST', REGISTRATION, ''),
    withoutHost as unknown as ServerResponse,
    '/api/sonnclients/register',
  );
  assert.equal(withoutHost.json().sendspin_url, 'ws://192.168.1.209:7090/sendspin');
});

test('what the admin UI saves is what the device is told, on its next poll', async () => {
  const { call, admin } = createHarness();
  await call('POST', '/api/sonnclients/register', REGISTRATION);

  const saved = await admin('PUT', '/sonnclients/sonn-kitchen-9e2f', {
    name: 'Kitchen',
    players: [
      {
        clientId: 'sonn-kitchen-9e2f',
        name: 'Kitchen',
        output: 'hw:CARD=DAC,DEV=0',
        delayMs: 120,
        volume: 80,
        volumeHook: '/usr/local/bin/beolab-volume',
      },
    ],
    sources: [
      {
        clientId: 'sonn-kitchen-9e2f-linein',
        name: 'BeoSound 9000',
        input: 'hw:CARD=CODEC,DEV=0',
        thresholdDb: -45,
        holdMs: 2000,
        controls: ['activate', 'play'],
        controlHook: '/usr/local/bin/ml-cmd',
      },
    ],
    beoremote: { enabled: true, zoneId: 28, volumeStep: 4 },
  });
  assert.equal(saved.statusCode, 200);

  const status = await call('POST', '/api/sonnclients/sonn-kitchen-9e2f/status', {
    state: 'connected',
    version: '0.1.0',
    uptime_s: 12,
    players: [],
  });
  const desired = status.json();
  assert.equal(desired.device_name, 'Kitchen');
  assert.equal(desired.players.length, 1);
  assert.equal(desired.players[0].client_id, 'sonn-kitchen-9e2f');
  assert.equal(desired.players[0].output, 'hw:CARD=DAC,DEV=0');
  // Wire names are snake_case and mean what the client's own fields mean.
  assert.equal(desired.players[0].static_delay_ms, 120);
  assert.equal(desired.players[0].volume_hook, '/usr/local/bin/beolab-volume');
  assert.equal(desired.sources[0].control_hook, '/usr/local/bin/ml-cmd');
  assert.equal(desired.sources[0].threshold_db, -45);
  assert.deepEqual(desired.sources[0].controls, ['activate', 'play']);
  assert.equal(desired.beoremote.zone_id, 28);
});

test('how a speaker applies volume reaches the device, and nonsense does not', async () => {
  const { call, admin } = createHarness();
  await call('POST', '/api/sonnclients/register', REGISTRATION);

  await admin('PUT', '/sonnclients/sonn-kitchen-9e2f', {
    players: [
      {
        clientId: 'sonn-kitchen-9e2f',
        output: 'alsa:hw:CARD=CDCACM,DEV=0',
        volumeControl: 'ALSA',
        mixerElement: 'PCM',
        mixerMapped: false,
      },
      {
        clientId: 'sonn-kitchen-9e2f-2',
        output: 'alsa:hw:CARD=DAC,DEV=0',
        volumeControl: 'whatever the next version calls it',
      },
    ],
  });

  const desired = (
    await call('POST', '/api/sonnclients/sonn-kitchen-9e2f/status', {
      state: 'connected',
      players: [],
    })
  ).json();

  assert.equal(desired.players[0].volume_control, 'alsa');
  assert.equal(desired.players[0].mixer_element, 'PCM');
  // False is a decision, not an absence: this is the setting that keeps a mixer calibrated in dB
  // from having a second perceptual curve laid on top of it.
  assert.equal(desired.players[0].mixer_mapped, false);

  // An unknown route becomes absent rather than an error, which the device reads as "decide for
  // yourself" -- the sane outcome for a setting the hardware knows more about than this config does.
  assert.equal(desired.players[1].volume_control, undefined);
});

test('every device is told which client build it should be running', async () => {
  const { call, admin, config } = createHarness();
  await call('POST', '/api/sonnclients/register', REGISTRATION);

  // Published centrally, not per device: a park where some speakers quietly stay behind on an old
  // version is the thing a central version exists to prevent.
  config.sonnClients = config.sonnClients ?? {};
  config.sonnClients.components = [
    {
      name: 'sonn-client',
      version: '1.2.3',
      urls: { aarch64: 'https://example.test/sonn-client-1.2.3-aarch64.tar.gz' },
      sha256: { aarch64: 'a'.repeat(64) },
    },
  ];

  const desired = (
    await call('POST', '/api/sonnclients/sonn-kitchen-9e2f/status', {
      state: 'connected',
      players: [],
    })
  ).json();

  const client = desired.components.find(
    (component: { name?: string }) => component.name === 'sonn-client',
  );
  assert.ok(client, 'the client build is offered without the device asking for it');
  assert.equal(client.version, '1.2.3');
  assert.equal(client.sha256, 'a'.repeat(64));
});

test('an input takes its format from the line-in it feeds, not from the device entry', async () => {
  const { call, admin, config } = createHarness();
  await call('POST', '/api/sonnclients/register', REGISTRATION);

  await admin('PUT', '/sonnclients/sonn-kitchen-9e2f', {
    sources: [{ clientId: 'sonn-kitchen-9e2f-linein', input: 'alsa:hw:CARD=CODEC,DEV=0' }],
  });

  // Set where someone actually thinks about this input. Both places used to carry these numbers,
  // and the device quietly ran on its own defaults while this screen showed something else.
  config.inputs = {
    lineIn: {
      inputs: [
        {
          id: 'linein-1',
          name: 'BeoSound 9000',
          source: {
            type: 'sendspin',
            clientId: 'sonn-kitchen-9e2f-linein',
            sample_rate: 44100,
            bit_depth: 24,
            channels: 2,
            codec: 'pcm',
            vad_threshold_db: -52,
            vad_hold_ms: 3000,
          },
        },
      ],
    },
  } as never;

  const desired = (
    await call('POST', '/api/sonnclients/sonn-kitchen-9e2f/status', {
      state: 'connected',
      players: [],
    })
  ).json();

  const source = desired.sources[0];
  assert.equal(source.sample_rate, 44100);
  assert.equal(source.bit_depth, 24);
  assert.equal(source.threshold_db, -52);
  assert.equal(source.hold_ms, 3000);
});

test('a transport command for an input reaches the device that provides it', async () => {
  const commands = new Map<string, Array<{ command: string; args: string[] }>>([
    ['linein-1', [{ command: 'next', args: [] }]],
  ]);
  const active = new Set<string>(['linein-1']);
  const { call, admin, config } = createHarness({
    lineInActivation: {
      takeCommands: (inputId: string) => {
        const queued = commands.get(inputId) ?? [];
        commands.delete(inputId);
        return queued;
      },
      isActive: (inputId: string) => active.has(inputId),
    },
  });
  await call('POST', '/api/sonnclients/register', REGISTRATION);
  await admin('PUT', '/sonnclients/sonn-kitchen-9e2f', {
    sources: [{ clientId: 'sonn-kitchen-9e2f-linein', input: 'alsa:hw:CARD=CODEC,DEV=0' }],
  });
  config.inputs = {
    lineIn: {
      inputs: [
        { id: 'linein-1', source: { type: 'sendspin', clientId: 'sonn-kitchen-9e2f-linein' } },
      ],
    },
  } as never;

  const first = (
    await call('POST', '/api/sonnclients/sonn-kitchen-9e2f/status', {
      state: 'connected',
      players: [],
    })
  ).json();

  assert.deepEqual(first.source_commands, [
    { client_id: 'sonn-kitchen-9e2f-linein', command: 'next', args: [] },
  ]);
  // A room is listening to this input, so the device is asked to come back quickly: five seconds
  // between pressing next and the track changing is a remote nobody uses.
  assert.equal(first.poll_interval_ms, 1000);

  // Draining is what acknowledges delivery, so the same press does not arrive twice.
  const second = (
    await call('POST', '/api/sonnclients/sonn-kitchen-9e2f/status', {
      state: 'connected',
      players: [],
    })
  ).json();
  assert.deepEqual(second.source_commands, []);

  active.clear();
  const third = (
    await call('POST', '/api/sonnclients/sonn-kitchen-9e2f/status', {
      state: 'connected',
      players: [],
    })
  ).json();
  assert.equal(third.poll_interval_ms, 5000, 'nothing to be quick about once the room moves on');
});

test('a room claims a remote, the device does not claim a room', async () => {
  const { call, admin, config } = createHarness();
  await call('POST', '/api/sonnclients/register', REGISTRATION);
  await admin('PUT', '/sonnclients/sonn-kitchen-9e2f', { name: 'Kitchen' });

  // Nothing on the device says which room it drives. Pairing is a fact about the box; which room a
  // remote belongs to is a fact about the room, and it is set beside that room's output.
  config.zones = [
    { id: 12, name: 'Kitchen', inputs: { beoremote: { enabled: true, deviceId: 'sonn-kitchen-9e2f', volumeStep: 6 } } },
  ] as never;

  const desired = (
    await call('POST', '/api/sonnclients/sonn-kitchen-9e2f/status', {
      state: 'connected',
      players: [],
    })
  ).json();
  assert.equal(desired.beoremote.zone_id, 12);
  assert.equal(desired.beoremote.volume_step, 6);

  // A room that claimed it and then switched it off is not driving anything.
  config.zones[0].inputs.beoremote.enabled = false;
  const off = (
    await call('POST', '/api/sonnclients/sonn-kitchen-9e2f/status', {
      state: 'connected',
      players: [],
    })
  ).json();
  assert.equal(off.beoremote, undefined);
});

test('a disabled device keeps polling and is told to play nothing', async () => {
  const { call, admin } = createHarness();
  await call('POST', '/api/sonnclients/register', REGISTRATION);
  await admin('PUT', '/sonnclients/sonn-kitchen-9e2f', {
    players: [{ clientId: 'sonn-kitchen-9e2f', output: 'default' }],
    enabled: false,
  });

  const desired = (await call('POST', '/api/sonnclients/sonn-kitchen-9e2f/status', {})).json();
  // No endpoint and no players: parked, not broken. The device stays registered, so turning it
  // back on is one poll away.
  assert.equal(desired.sendspin_url, undefined);
  assert.deepEqual(desired.players, []);
});

test('a queued command is handed over once', async () => {
  const { call, admin } = createHarness();
  await call('POST', '/api/sonnclients/register', REGISTRATION);

  const accepted = await admin('POST', '/sonnclients/sonn-kitchen-9e2f/commands', {
    command: 'pair_remote',
  });
  assert.equal(accepted.statusCode, 202);

  const first = (await call('POST', '/api/sonnclients/sonn-kitchen-9e2f/status', {})).json();
  assert.deepEqual(first.commands, [{ command: 'pair_remote', args: [] }]);
  // Drained, so the device does not re-run a pairing window on every poll.
  const second = (await call('POST', '/api/sonnclients/sonn-kitchen-9e2f/status', {})).json();
  assert.deepEqual(second.commands, []);

  const refused = await admin('POST', '/sonnclients/sonn-kitchen-9e2f/commands', {
    command: 'rm -rf /',
  });
  assert.equal(refused.statusCode, 400);
});

test('a component is resolved to the artifact for the device architecture', async () => {
  const { call, admin } = createHarness({
    sonnClients: {
      components: [
        {
          name: 'sonn-beoremote',
          version: '5.45-bo1',
          urls: {
            aarch64: 'https://example.test/sonn-beoremote-aarch64.tar.gz',
            armv7l: 'https://example.test/sonn-beoremote-armv7l.tar.gz',
          },
          sha256: { aarch64: 'a'.repeat(64), armv7l: 'b'.repeat(64) },
        },
      ],
    },
  });
  await call('POST', '/api/sonnclients/register', REGISTRATION);
  await admin('PUT', '/sonnclients/sonn-kitchen-9e2f', {
    requiredComponents: ['sonn-beoremote'],
  });

  const desired = (await call('POST', '/api/sonnclients/sonn-kitchen-9e2f/status', {})).json();
  assert.equal(desired.components.length, 1);
  assert.equal(desired.components[0].url, 'https://example.test/sonn-beoremote-aarch64.tar.gz');
  assert.equal(desired.components[0].sha256, 'a'.repeat(64));
});

test('a component with no artifact for this architecture is left out rather than sent broken', async () => {
  const { call, admin } = createHarness({
    sonnClients: {
      components: [
        {
          name: 'sonn-beoremote',
          urls: { armv7l: 'https://example.test/armv7l.tar.gz' },
          sha256: { armv7l: 'b'.repeat(64) },
        },
      ],
    },
  });
  await call('POST', '/api/sonnclients/register', REGISTRATION);
  await admin('PUT', '/sonnclients/sonn-kitchen-9e2f', {
    requiredComponents: ['sonn-beoremote'],
  });

  // The client refuses an unverified install anyway; refusing it here is where the reason is
  // visible.
  const desired = (await call('POST', '/api/sonnclients/sonn-kitchen-9e2f/status', {})).json();
  assert.deepEqual(desired.components, []);
});

test('a zone claims a device radio for Bluetooth, and names what a phone sees', async () => {
  const { config, call, admin } = createHarness();
  await call('POST', '/api/sonnclients/register', REGISTRATION);
  await admin('PUT', '/sonnclients/sonn-kitchen-9e2f', { name: 'Kitchen' });

  // Same split as the remote: the radio is the device's, the room decides whether it is used.
  config.zones = [
    {
      id: 12,
      name: 'Kitchen',
      inputs: {
        bluetooth: {
          enabled: true,
          deviceId: 'sonn-kitchen-9e2f',
          discoverableSeconds: 120,
          pin: '0000',
        },
      },
    },
  ] as never;

  const desired = (
    await call('POST', '/api/sonnclients/sonn-kitchen-9e2f/status', { state: 'connected' })
  ).json();
  assert.equal(desired.bluetooth.zone_id, 12);
  // What someone looks for on their phone is the room, not the hostname of a box in a cupboard.
  assert.equal(desired.bluetooth.name, 'Kitchen');
  assert.equal(desired.bluetooth.discoverable_seconds, 120);
  assert.equal(desired.bluetooth.pin, '0000');
  assert.equal(desired.bluetooth.control, true);

  // A name given here wins over the room's own.
  (config.zones[0] as never as { inputs: { bluetooth: { publishName?: string } } }).inputs.bluetooth.publishName =
    'Keuken speaker';
  const renamed = (
    await call('POST', '/api/sonnclients/sonn-kitchen-9e2f/status', { state: 'connected' })
  ).json();
  assert.equal(renamed.bluetooth.name, 'Keuken speaker');

  // Switched off is not "as before": the device should stop accepting phones.
  (config.zones[0] as never as { inputs: { bluetooth: { enabled: boolean } } }).inputs.bluetooth.enabled = false;
  const off = (
    await call('POST', '/api/sonnclients/sonn-kitchen-9e2f/status', { state: 'connected' })
  ).json();
  assert.equal(off.bluetooth, undefined);
});

test('the Bluetooth commands an operator may send are the two that exist', async () => {
  const { call, admin } = createHarness();
  await call('POST', '/api/sonnclients/register', REGISTRATION);

  for (const command of ['bluetooth_discoverable', 'bluetooth_forget']) {
    const accepted = await admin('POST', '/sonnclients/sonn-kitchen-9e2f/commands', { command });
    assert.equal(accepted.statusCode, 202, command);
  }
  // Anything else is refused rather than passed to someone's hardware.
  const refused = await admin('POST', '/sonnclients/sonn-kitchen-9e2f/commands', {
    command: 'bluetooth_anything_else',
  });
  assert.equal(refused.statusCode, 400);
});

test('a device a zone plays through cannot be forgotten', async () => {
  const { config, call, admin } = createHarness();
  await call('POST', '/api/sonnclients/register', REGISTRATION);
  await admin('PUT', '/sonnclients/sonn-kitchen-9e2f', {
    players: [{ clientId: 'sonn-kitchen-9e2f', output: 'default' }],
  });
  config.zones.push({
    id: 28,
    name: 'Kitchen',
    output: { id: 'sendspin', clientId: 'sonn-kitchen-9e2f' },
  });

  const refused = await admin('DELETE', '/sonnclients/sonn-kitchen-9e2f');
  assert.equal(refused.statusCode, 409);
  assert.deepEqual(refused.json().clientIds, ['sonn-kitchen-9e2f']);

  // Repointed: now it can go.
  config.zones = [];
  const removed = await admin('DELETE', '/sonnclients/sonn-kitchen-9e2f');
  assert.equal(removed.statusCode, 204);
  assert.equal(config.sonnClients.devices.length, 0);
});

test('a satellite listening alongside a zone counts as in use', async () => {
  const { config, call, admin } = createHarness();
  await call('POST', '/api/sonnclients/register', REGISTRATION);
  await admin('PUT', '/sonnclients/sonn-kitchen-9e2f', {
    players: [{ clientId: 'sonn-kitchen-9e2f', output: 'default' }],
  });
  // A subwoofer under a pair of speakers is not the zone's own output, and forgetting it would
  // silence it with nothing in the UI to explain why.
  config.zones.push({
    id: 12,
    name: 'Living',
    output: { id: 'sendspin', clientId: 'other-client', satellites: ['sonn-kitchen-9e2f'] },
  });

  const refused = await admin('DELETE', '/sonnclients/sonn-kitchen-9e2f');
  assert.equal(refused.statusCode, 409);
});

test('a line-in fed by a source client counts as in use too', async () => {
  const { config, call, admin } = createHarness();
  await call('POST', '/api/sonnclients/register', REGISTRATION);
  await admin('PUT', '/sonnclients/sonn-kitchen-9e2f', {
    sources: [{ clientId: 'sonn-kitchen-9e2f-linein', input: 'hw:CARD=CODEC,DEV=0' }],
  });
  config.inputs.lineIn = {
    inputs: [{ name: 'BeoSound 9000', source: { type: 'sendspin', clientId: 'sonn-kitchen-9e2f-linein' } }],
  };

  const refused = await admin('DELETE', '/sonnclients/sonn-kitchen-9e2f');
  assert.equal(refused.statusCode, 409);
});

test('two players cannot claim one client id', async () => {
  const { call, admin } = createHarness();
  await call('POST', '/api/sonnclients/register', REGISTRATION);

  const refused = await admin('PUT', '/sonnclients/sonn-kitchen-9e2f', {
    players: [
      { clientId: 'sonn-kitchen-9e2f', output: 'default' },
      { clientId: 'sonn-kitchen-9e2f', output: 'hw:CARD=DAC,DEV=0' },
    ],
  });
  // The device would open two connections claiming to be the same client, and the server would
  // read the second as a reconnect of the first.
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().error, 'duplicate-client-id');
});

test('a beoremote without a zone is refused', async () => {
  const { call, admin } = createHarness();
  await call('POST', '/api/sonnclients/register', REGISTRATION);
  const refused = await admin('PUT', '/sonnclients/sonn-kitchen-9e2f', {
    beoremote: { enabled: true },
  });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().error, 'beoremote-missing-zone');
});

test('an edit does not overwrite what the device reported about itself', async () => {
  const { config, call, admin } = createHarness();
  await call('POST', '/api/sonnclients/register', REGISTRATION);
  await admin('PUT', '/sonnclients/sonn-kitchen-9e2f', { name: 'Kitchen' });

  const stored = config.sonnClients.devices[0];
  assert.equal(stored.name, 'Kitchen');
  assert.equal(stored.hostname, 'kitchen-pi');
  assert.equal(stored.mac, 'DC:A6:32:1B:44:90');
});

test('the card list survives a status poll that omits it', async () => {
  const { call, handler } = createHarness();
  await call('POST', '/api/sonnclients/register', REGISTRATION);
  // Omitted means "as before" -- the client only re-sends the list when it changed, and treating
  // absence as "no cards" would empty the picker on every poll.
  await call('POST', '/api/sonnclients/sonn-kitchen-9e2f/status', { state: 'connected' });
  assert.equal(handler.viewForAdmin('sonn-kitchen-9e2f').registration?.outputs.length, 2);

  await call('POST', '/api/sonnclients/sonn-kitchen-9e2f/status', {
    state: 'connected',
    outputs: [{ id: 'default', name: 'Default' }],
  });
  assert.equal(handler.viewForAdmin('sonn-kitchen-9e2f').registration?.outputs.length, 1);
});

test('a device is offline once it stops polling', async () => {
  const { call, handler } = createHarness();
  await call('POST', '/api/sonnclients/register', REGISTRATION);
  assert.equal(handler.viewForAdmin('sonn-kitchen-9e2f').online, false, 'registering is not a poll');

  await call('POST', '/api/sonnclients/sonn-kitchen-9e2f/status', { state: 'streaming' });
  assert.equal(handler.viewForAdmin('sonn-kitchen-9e2f').online, true);
});
