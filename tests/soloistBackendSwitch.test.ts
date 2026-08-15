import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SpotifyInputService } from '../src/adapters/inputs/spotify/spotifyInputService';
import { SpotifyDeviceRegistry } from '../src/adapters/outputs/spotify/deviceRegistry';
import type { ConfigPort } from '../src/ports/ConfigPort';

/**
 * Switching to Soloist has to take librespot with it.
 *
 * Both clients want to be the account's device for a room, and the accounts Soloist exists for are
 * exactly the ones librespot can no longer log in as. A Connect host left running after the switch
 * therefore does not sit idle — it retries credentials Spotify keeps refusing, filling the log with
 * `Try another access point` for a player nobody chose.
 */

type ConfigShape = {
  zones: Array<{ id: number; name: string; inputs?: { spotify?: { enabled: boolean } } }>;
  content?: { spotify?: { soloist?: { enabled?: boolean; apiKey?: string } } };
  system?: { audioserver?: { uuid?: string } };
};

function fakeConfigPort(config: ConfigShape): ConfigPort {
  return {
    getConfig: () => config,
    ensureInputs: () => undefined,
    updateConfig: async (mutate: (cfg: unknown) => void) => {
      mutate(config);
    },
  } as unknown as ConfigPort;
}

function buildService(config: ConfigShape): SpotifyInputService {
  const service = new SpotifyInputService(
    () => undefined,
    fakeConfigPort(config),
    { get: () => undefined } as never,
    new SpotifyDeviceRegistry(),
    () => undefined,
    {} as never,
    {} as never,
  );
  // What Soloist does with the zones is its own business (and would start processes and fetch a
  // build); these tests are about what is left of the other player once it has them.
  (service.soloist as unknown as { syncZones: () => Promise<void> }).syncZones = async () =>
    undefined;
  service.configure({} as never);
  return service;
}

test('turning soloist on takes every librespot connect host with it', () => {
  const config: ConfigShape = {
    zones: [
      { id: 1, name: 'TV Kamer', inputs: { spotify: { enabled: true } } },
      { id: 2, name: 'Keuken', inputs: { spotify: { enabled: true } } },
    ],
    content: { spotify: { soloist: { enabled: false } } },
    system: { audioserver: { uuid: 'test-server' } },
  };
  const service = buildService(config);

  service.syncZones(config.zones as never, null);
  assert.equal(service.listCredentialStates().length, 2, 'librespot runs the zones to begin with');

  // What the admin screen does when the player is changed.
  config.content!.spotify!.soloist = { enabled: true, apiKey: 'spak_test' };
  service.syncZones(config.zones as never, null);
  assert.deepEqual(service.listCredentialStates(), [], 'nothing librespot is left behind');
});

test('a zone whose connect host was retiring cannot restart itself once retired', async () => {
  const config: ConfigShape = {
    zones: [{ id: 1, name: 'TV Kamer', inputs: { spotify: { enabled: true } } }],
    content: { spotify: { soloist: { enabled: true, apiKey: 'spak_test' } } },
    system: { audioserver: { uuid: 'test-server' } },
  };
  const service = buildService(config);
  service.syncZones(config.zones as never, null);

  // A start queued or scheduled before the switch used to fire afterwards and log in again: the
  // instance was stopped, but `stopping` is cleared the moment stop() returns, so nothing said no.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(service.listCredentialStates(), [], 'no host came back after the switch');
});
