import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SoloistPlaybackService } from '../src/adapters/inputs/spotify/soloist/soloistPlaybackService';
import type { ConfigPort } from '../src/ports/ConfigPort';

/**
 * Soloist is the only Spotify client, so there is nothing to switch between and no flag saying
 * which one to use: the API key is what decides. It is personal and Premium-only, so it is never
 * there by accident — and its absence is a normal state a fresh install sits in, which is why the
 * one thing pinned here is that such a setup says what is missing rather than failing later.
 */

type ConfigShape = {
  zones?: Array<{ id: number; name?: string }>;
  content?: { spotify?: { soloist?: { apiKey?: string } } };
};

function fakeConfigPort(config: ConfigShape): ConfigPort {
  return {
    getConfig: () => config,
    updateConfig: async (mutate: (cfg: unknown) => void) => {
      mutate(config);
    },
  } as unknown as ConfigPort;
}

test('an installation with no key does not play spotify', () => {
  // And does not advertise a room in anybody's Spotify app either: a key is the one thing that
  // cannot be defaulted or shipped, so its absence is what an untouched install looks like.
  for (const soloist of [undefined, {}, { apiKey: '' }, { apiKey: '   ' }]) {
    const service = new SoloistPlaybackService(
      fakeConfigPort({ content: { spotify: { soloist } }, zones: [{ id: 1 }] }),
    );
    assert.equal(service.isEnabled(), false, JSON.stringify(soloist));
  }
});

test('a key is the whole of switching it on', () => {
  // There is no second flag to set. One client, so a switch beside the key could only ever be on.
  const service = new SoloistPlaybackService(
    fakeConfigPort({ content: { spotify: { soloist: { apiKey: 'spak_test' } } } }),
  );
  assert.equal(service.isEnabled(), true);
});

test('readiness names the step that is missing rather than just refusing', async () => {
  // The key is personal and Premium-only, so it can never be defaulted or shipped, which makes
  // "no key" a normal state the screen has to be able to explain rather than a failure.
  const noKey = new SoloistPlaybackService(fakeConfigPort({ content: { spotify: { soloist: {} } } }));
  assert.deepEqual(await noKey.readiness('acc'), { ready: false, reason: 'no_api_key' });

  // With a key but no account named, there is no store to restore a session from.
  const noAccount = new SoloistPlaybackService(
    fakeConfigPort({ content: { spotify: { soloist: { apiKey: 'spak_test' } } } }),
  );
  const readiness = await noAccount.readiness('');
  assert.equal(readiness.ready, false);
  // Which of the two it reports depends on whether a program is installed on the host running the
  // tests, and both are honest answers; what matters is that it is named rather than swallowed.
  assert.ok(
    readiness.ready === false && ['no_binary', 'not_executable', 'no_account'].includes(readiness.reason),
    JSON.stringify(readiness),
  );
});
