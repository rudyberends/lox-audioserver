import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SonnClientApiHandler } from '../src/adapters/http/sonnClientApi/sonnClientApiHandler';

/**
 * Who may take on a speaker.
 *
 * A device announces itself to every server it can find. Alone, a server takes it on and the
 * ordinary house never sees any of this. The trap is what "alone" means during a restart: for a
 * minute the other server really is the only one answering, and a speaker that had been playing a
 * room for months walked over to it and stayed. So the device says whose it is, and a server that
 * has never seen it leaves it alone.
 */
function handlerFor(devices: Array<{ deviceId: string }>): {
  handler: SonnClientApiHandler;
  written: Array<{ deviceId: string }>;
} {
  const written = [...devices];
  const configPort = {
    getConfig: () => ({ sonnClients: { devices: written }, zones: [] }),
    getSystemConfig: () => ({}),
    updateConfig: async (mutate: (cfg: unknown) => void) => {
      const cfg = { sonnClients: { devices: written } };
      mutate(cfg);
      return cfg;
    },
  };
  return { handler: new SonnClientApiHandler(configPort as never, 7090), written };
}

function register(handler: SonnClientApiHandler, body: unknown): Promise<Record<string, unknown>> {
  const req = Object.assign(
    (async function* () {
      yield Buffer.from(JSON.stringify(body));
    })(),
    { headers: { host: 'this-server:7090' }, method: 'POST', on: () => undefined },
  );
  // The handler reads the body off the stream and answers through res; both are faked down to what
  // it actually touches.
  let answered: Record<string, unknown> = {};
  const res = {
    writeHead: () => res,
    end: (payload?: string) => {
      answered = payload ? (JSON.parse(payload) as Record<string, unknown>) : {};
      return res;
    },
    writableEnded: false,
  };
  const chunks: Buffer[] = [Buffer.from(JSON.stringify(body))];
  const stream = {
    headers: { host: 'this-server:7090' },
    method: 'POST',
    on(event: string, handlerFn: (chunk?: Buffer) => void) {
      if (event === 'data') chunks.forEach((chunk) => handlerFn(chunk));
      if (event === 'end') handlerFn();
      return stream;
    },
  };
  void req;
  return handler
    .handle(stream as never, res as never, '/api/sonnclients/register')
    .then(() => answered);
}

test('a server that has never seen a device does not adopt one that belongs elsewhere', async () => {
  const { handler, written } = handlerFor([]);
  const answer = await register(handler, {
    device_id: 'sonn-woonkamer-4791fbc6',
    outputs: [],
    inputs: [],
    // Alone on the network right now — the other server is restarting — but the device knows better.
    servers: [{ name: 'This one', url: 'http://this-server:7090' }],
    attached_to: 'http://192.168.1.209:7090',
  });

  assert.equal(answer.claimed, false, 'it is left alone');
  assert.equal(written.length, 0, 'and not written into the config');
});

test('a stale entry does not outrank the device: the drift is not repeated', async () => {
  // This server adopted the device once, during another server's restart, and still has the entry.
  const { handler } = handlerFor([{ deviceId: 'sonn-woonkamer-4791fbc6' }]);
  const answer = await register(handler, {
    device_id: 'sonn-woonkamer-4791fbc6',
    outputs: [],
    inputs: [],
    servers: [{ name: 'This one', url: 'http://this-server:7090' }],
    attached_to: 'http://192.168.1.209:7090',
  });

  assert.equal(answer.claimed, false, 'it goes back to the server it names');
});

test('a device that names this server is taken on', async () => {
  const { handler, written } = handlerFor([]);
  const answer = await register(handler, {
    device_id: 'sonn-woonkamer-4791fbc6',
    outputs: [],
    inputs: [],
    servers: [{ name: 'This one', url: 'http://this-server:7090' }],
    attached_to: 'http://this-server:7090',
  });

  assert.equal(answer.claimed, true);
  assert.equal(written.length, 1);
  assert.equal(written[0]?.deviceId, 'sonn-woonkamer-4791fbc6');
});
