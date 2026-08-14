import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SoloistPlaybackService } from '../src/adapters/inputs/spotify/soloist/soloistPlaybackService';
import type { ConfigPort } from '../src/ports/ConfigPort';

/**
 * Soloist is a second player, not a replacement. These pin the two properties that keep it that
 * way: an installation that never asked for it keeps the built-in one, and a setup that cannot
 * possibly play says which step is missing rather than failing somewhere later.
 */

type ConfigShape = {
  zones?: Array<{ id: number; name?: string }>;
  content?: { spotify?: { soloist?: { enabled?: boolean; apiKey?: string } } };
};

function fakeConfigPort(config: ConfigShape): ConfigPort {
  return {
    getConfig: () => config,
    updateConfig: async (mutate: (cfg: unknown) => void) => {
      mutate(config);
    },
  } as unknown as ConfigPort;
}

test('an installation that has never heard of soloist keeps the built-in player', () => {
  // Which client plays is one choice for the whole server, and absence of it has to mean the
  // player every existing install is already using.
  for (const soloist of [undefined, {}, { enabled: false }, { apiKey: 'spak_test' }]) {
    const service = new SoloistPlaybackService(
      fakeConfigPort({ content: { spotify: { soloist } }, zones: [{ id: 1 }] }),
    );
    assert.equal(service.isEnabled(), false, JSON.stringify(soloist));
  }
});

test('soloist plays once it is switched on', () => {
  const service = new SoloistPlaybackService(
    fakeConfigPort({ content: { spotify: { soloist: { enabled: true, apiKey: 'spak_test' } } } }),
  );
  assert.equal(service.isEnabled(), true);
});

test('readiness names the step that is missing rather than just refusing', async () => {
  const disabled = new SoloistPlaybackService(fakeConfigPort({ content: { spotify: { soloist: {} } } }));
  assert.deepEqual(await disabled.readiness(1), { ready: false, reason: 'disabled' });

  // Enabled but with nothing to authenticate with: the key is personal and Premium-only, so it can
  // never be defaulted or shipped, which makes "no key" a normal state the screen must explain.
  const noKey = new SoloistPlaybackService(
    fakeConfigPort({ content: { spotify: { soloist: { enabled: true } } } }),
  );
  assert.deepEqual(await noKey.readiness(1), { ready: false, reason: 'no_api_key' });
});
