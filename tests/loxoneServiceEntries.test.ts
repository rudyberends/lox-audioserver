import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SpotifyServiceManager } from '../src/adapters/content/providers/spotifyServiceManager';
import type { ConfigPort } from '../src/ports/ConfigPort';

/**
 * The `getservices` payload, field by field.
 *
 * The Loxone app expects this exactly as it is and has no tolerance to spare: every service is
 * announced as `cmd: 'spotify'` because Spotify is the only streaming source it knows, bridges
 * carry an empty `name` so the app falls back to the account label, and the empty arrays are
 * there because their absence is not the same as their emptiness.
 *
 * Pinned whole rather than sampled. This payload has no test that would notice a field going
 * missing, and the provider refactor did drift the `icon` values before this test existed.
 */
const CONFIG = {
  content: {
    spotify: { accounts: [{ id: 'md123121', displayName: 'Rudy', email: 'r@example.com', product: 'premium' }] },
    streamingServices: [
      { id: 'bridge-applemusic-12lijl', label: 'Apple Music', provider: 'applemusic' },
      { id: 'bridge-ytmusic-c89xxz', label: 'YouTube Music', provider: 'ytmusic' },
    ],
  },
  system: { audioserver: { ip: '127.0.0.1' } },
};

function makeManager(): SpotifyServiceManager {
  const configPort = {
    getConfig: () => CONFIG,
    load: async () => CONFIG,
    updateConfig: async () => {},
  } as unknown as ConfigPort;
  return new SpotifyServiceManager(
    configPort,
    CONFIG.content.spotify.accounts,
    undefined,
    CONFIG.content.streamingServices,
  );
}

test('getservices announces a real Spotify account exactly as the app expects', () => {
  const entries = makeManager().listServiceEntries();
  assert.deepEqual(entries[0], {
    cmd: 'spotify',
    name: 'Spotify',
    icon: 'https://extended-app-content.s3.eu-central-1.amazonaws.com/audioZone/services/Icon-Spotify.svg',
    id: 'md123121',
    user: 'Rudy',
    email: 'r@example.com',
    product: 'premium',
    asdefault: [],
    offline_storage: [],
    configerror: false,
    provider: 'spotify',
    fake: false,
  });
});

test('getservices announces a bridged service under the Spotify command, named for itself', () => {
  const entries = makeManager().listServiceEntries();
  assert.deepEqual(entries[1], {
    cmd: 'spotify',
    // Empty on purpose: the app shows the account label for a bridge, not the service name.
    name: '',
    icon: '/admin/providers/apple-music.svg',
    id: 'bridge-applemusic-12lijl',
    user: 'Apple Music',
    email: 'bridge-applemusic-12lijl@sonn-core.io',
    product: '',
    asdefault: [],
    offline_storage: [],
    configerror: false,
    provider: 'applemusic',
    fake: true,
  });
  assert.deepEqual(entries[2], {
    cmd: 'spotify',
    name: '',
    icon: '/admin/providers/youtube-music.svg',
    id: 'bridge-ytmusic-c89xxz',
    user: 'YouTube Music',
    email: 'bridge-ytmusic-c89xxz@sonn-core.io',
    product: '',
    asdefault: [],
    offline_storage: [],
    configerror: false,
    provider: 'ytmusic',
    fake: true,
  });
});

test('every configured service is announced, real and bridged alike', () => {
  const entries = makeManager().listServiceEntries();
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.cmd), ['spotify', 'spotify', 'spotify']);
});

test('the internal account list keys a bridge by its provider-map id', () => {
  const accounts = makeManager().listAccounts();
  assert.deepEqual(accounts, [
    { id: 'spotify@md123121', label: 'Rudy', provider: 'spotify', fake: false, product: 'premium' },
    { id: 'spotify@bridge-applemusic-12lijl', label: 'applemusic', provider: 'applemusic', fake: true },
    { id: 'spotify@bridge-ytmusic-c89xxz', label: 'ytmusic', provider: 'ytmusic', fake: true },
  ]);
});
