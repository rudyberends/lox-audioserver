import assert from 'node:assert/strict';
import { test } from './testHarness';
import { buildConfigRoutes } from '../src/adapters/http/adminApi/config/configHandlers';

/**
 * Clearing the configuration has to clear all of it.
 *
 * It used to assign the defaults on top of what was there, which only replaced the sections the
 * defaults name. Everything added since — Sonn client devices, and whatever comes next — survived a
 * reset: a speaker that had been wiped and reinstalled kept coming back as an offline ghost, with no
 * way to tell from the screen why.
 */
test('clearing the configuration drops sections the defaults do not name', async () => {
  let stored: Record<string, unknown> = {
    system: { audioserver: { macId: 'AA:BB:CC:DD:EE:FF', name: 'Living room' } },
    zones: [{ id: 1, name: 'Kitchen' }],
    sonnClients: { devices: [{ deviceId: 'sonn-woonkamer-308e42d1' }] },
    somethingAddedLater: { keep: false },
  };

  const routes = buildConfigRoutes({
    configPort: {
      getConfig: () => stored,
      updateConfig: async (mutate: (cfg: Record<string, unknown>) => void) => {
        mutate(stored);
        return stored;
      },
    },
    zoneManager: { replaceAll: async () => {} },
    sendJson: () => {},
  } as never);

  const clear = routes.find(
    (route) => route.method === 'POST' && route.pattern.source.includes('clear'),
  );
  assert.ok(clear, 'the clear route is registered');

  await clear!.handler({} as never, {} as never, [] as never);

  assert.equal(stored.sonnClients, undefined, 'a wiped speaker does not come back');
  assert.equal(stored.somethingAddedLater, undefined, 'nor does any other section');
  assert.deepEqual(stored.zones, [], 'zones are emptied rather than left behind');
  // The one thing kept on purpose: this server's identity on the network.
  assert.equal(
    (stored.system as { audioserver: { macId: string } }).audioserver.macId,
    'AA:BB:CC:DD:EE:FF',
  );
});
