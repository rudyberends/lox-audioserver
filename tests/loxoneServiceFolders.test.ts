import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  providerTypeFromBridgeId,
  rootItemsForLoxone,
  serviceTypeFor,
  toProviderNode,
} from '../src/adapters/loxone/commands/utils/loxoneServiceFolders';
import { SpotifyAccountProvider } from '../src/adapters/content/providers/spotify/spotifyAccountProvider';

const APPLE = 'bridge-applemusic-dgmv27';

/** Every bridged service reaches us as `spotify`; the bridge id names the real one. */
const slot = (user: string, folderId: string) => toProviderNode('spotify', user, folderId);

// These six mappings are what the Loxone app has always received. The provider used
// to decode the slot indices itself; moving that here must not change a single one,
// so they are pinned rather than described.
test('Loxone service-folder slots map onto the same Apple Music nodes as before', () => {
  const expected: Array<[string, string]> = [
    ['0', 'new-releases'],
    ['1', 'recommended-playlists'],
    ['2', 'recommended-albums'],
    ['3', 'playlists'],
    ['5', 'albums'],
    ['6', 'artists'],
  ];
  for (const [index, node] of expected) {
    assert.equal(slot(APPLE, index), node, `slot ${index}`);
  }
});

test('a node name passes through untouched, so other consumers address nodes directly', () => {
  for (const node of ['root', 'albums', 'recent', 'songs', 'applemusic:album:123']) {
    assert.equal(slot(APPLE, node), node);
  }
});

test('a service without a slot table keeps its folder ids, so providers migrate one at a time', () => {
  for (const folderId of ['0', '5', 'albums']) {
    assert.equal(slot('bridge-tidal-abc123', folderId), folderId);
    assert.equal(toProviderNode('radioparadise', 'nouser', folderId), folderId);
  }
});

test('the root listing goes back to Loxone as its own slot indices', () => {
  const items = [
    { id: 'new-releases', name: 'New Releases' },
    { id: 'recommended-playlists', name: 'Recommended Playlists' },
    { id: 'recommended-albums', name: 'Recommended Albums' },
    { id: 'albums', name: 'Albums' },
    { id: 'artists', name: 'Artists' },
    { id: 'playlists', name: 'Playlists' },
  ];
  assert.deepEqual(
    rootItemsForLoxone('spotify', APPLE, items).map((item) => [item.id, item.name]),
    [
      ['0', 'New Releases'],
      ['1', 'Recommended Playlists'],
      ['2', 'Recommended Albums'],
      ['5', 'Albums'],
      ['6', 'Artists'],
      ['3', 'Playlists'],
    ],
  );
});

// The point of the whole exercise: a provider may publish nodes the Loxone app has
// no slot for. Those must not reach it — an unaddressable id in a fixed section
// would render the wrong content — while every other consumer sees them.
test('nodes without a Loxone slot are left out of the Loxone root', () => {
  const items = [
    { id: 'albums', name: 'Albums' },
    { id: 'recent', name: 'Recently Added' },
    { id: 'charts', name: 'Charts' },
  ];
  assert.deepEqual(
    rootItemsForLoxone('spotify', APPLE, items).map((item) => item.id),
    ['5'],
  );
});

test('providerTypeFromBridgeId reads the service out of a bridge id', () => {
  assert.equal(providerTypeFromBridgeId('bridge-applemusic-dgmv27'), 'applemusic');
  assert.equal(providerTypeFromBridgeId('bridge-tidal-abc'), 'tidal');
  assert.equal(providerTypeFromBridgeId('radioparadise'), '');
  assert.equal(providerTypeFromBridgeId(''), '');
});

// Each service fills the app's slots with its own sections, so every table is
// pinned separately: a wrong entry silently serves the wrong content in a section.
test('the YouTube services keep their own slot assignments', () => {
  const ytmusic: Array<[string, string]> = [
    ['0', 'popular'],
    ['1', 'new-releases'],
    ['2', 'genres'],
    ['3', 'playlists'],
    ['5', 'albums'],
    ['6', 'artists'],
  ];
  for (const [index, node] of ytmusic) {
    assert.equal(slot('bridge-ytmusic-x1', index), node, `ytmusic slot ${index}`);
  }

  const youtube: Array<[string, string]> = [
    ['0', 'trending'],
    ['1', 'new-releases'],
    ['2', 'genres'],
    ['3', 'playlists'],
  ];
  for (const [index, node] of youtube) {
    assert.equal(slot('bridge-youtube-y2', index), node, `youtube slot ${index}`);
  }
  // YouTube proper has no album/artist sections, so those slots stay unmapped.
  assert.equal(slot('bridge-youtube-y2', '5'), '5');
});

// Real Spotify is not bridged, so the service part of the command is the truth.
test('serviceTypeFor prefers the bridge id and falls back to the service', () => {
  assert.equal(serviceTypeFor('spotify', 'bridge-applemusic-dgmv27'), 'applemusic');
  assert.equal(serviceTypeFor('spotify', 'rudy@example.com'), 'spotify');
  assert.equal(serviceTypeFor('musicassistant', 'nouser'), 'musicassistant');
  assert.equal(serviceTypeFor('RadioParadise', 'nouser'), 'radioparadise');
});

// Spotify's own sections ARE the app's enum, in order — that is where the numbering
// came from. The provider publishes names now, so the order is pinned here instead.
test('Spotify itself maps the full enum onto its own section names', () => {
  const expected: Array<[string, string]> = [
    ['0', 'popular'],
    ['1', 'new'],
    ['2', 'genres'],
    ['3', 'playlists'],
    ['4', 'liked'],
    ['5', 'albums'],
    ['6', 'artists'],
    ['7', 'podcasts'],
  ];
  for (const [index, node] of expected) {
    assert.equal(toProviderNode('spotify', 'rudy@example.com', index), node, `slot ${index}`);
  }
  const items = expected.map(([, node]) => ({ id: node }));
  assert.deepEqual(
    rootItemsForLoxone('spotify', 'rudy@example.com', items).map((item) => item.id),
    ['0', '1', '2', '3', '4', '5', '6', '7'],
  );
});

test('SoundCloud maps its four sections onto the slots it used to publish', () => {
  const expected: Array<[string, string]> = [
    ['0', 'trending'],
    ['1', 'top'],
    ['3', 'playlists'],
    ['4', 'likes'],
  ];
  for (const [index, node] of expected) {
    assert.equal(slot('bridge-soundcloud-sc1', index), node, `slot ${index}`);
  }
  assert.deepEqual(
    rootItemsForLoxone('spotify', 'bridge-soundcloud-sc1', [
      { id: 'trending' },
      { id: 'playlists' },
    ]).map((item) => item.id),
    ['0', '3'],
  );
});

// Deezer and Music Assistant have always sent the app their node names rather than
// slot indices. Translating inbound is new; the outbound bytes must not move.
test('a service that publishes names keeps publishing them', () => {
  for (const user of ['bridge-deezer-dz1', 'bridge-musicassistant-ma1']) {
    const items = [{ id: 'playlists' }, { id: 'albums' }, { id: 'radios' }];
    assert.deepEqual(
      rootItemsForLoxone('spotify', user, items).map((item) => item.id),
      ['playlists', 'albums', 'radios'],
      user,
    );
  }
  assert.equal(slot('bridge-deezer-dz1', '1'), 'top-albums');
  assert.equal(slot('bridge-musicassistant-ma1', '5'), 'albums');
});

// Music Assistant hands its recommendation groups to the app under the slots its
// library sections do not claim. Translating one of those would steal it.
test('Music Assistant keeps the slots it fills with recommendations', () => {
  for (const index of ['0', '1', '2', '4']) {
    assert.equal(slot('bridge-musicassistant-ma1', index), index, `slot ${index}`);
  }
  assert.equal(slot('bridge-musicassistant-ma1', '3'), 'playlists');
  assert.equal(slot('bridge-musicassistant-ma1', '6'), 'artists');
});

// The table alone proves nothing: what the app receives is the provider's own root
// run through the projection. This is that pair, end to end — the eight sections in
// the order and under the ids the app has always got, straight from the provider.
test("Spotify's real root listing still reaches Loxone as slots 0-7", async () => {
  const provider = new SpotifyAccountProvider({
    providerId: 'spotify@rudy',
    // A refresh token is all the static root listing needs; nothing is fetched.
    account: { id: 'rudy', refreshToken: 'stub' } as never,
    persistAccount: async () => {},
  });
  const root = await provider.getFolder('root', 0, 50);
  assert.deepEqual(
    rootItemsForLoxone('spotify', 'rudy', root?.items ?? []).map((i) => [i.id, i.name]),
    [
      ['0', 'Popular Playlists'],
      ['1', 'New Releases'],
      ['2', 'Genres & Moods'],
      ['3', 'My Playlists'],
      ['4', 'Liked Songs'],
      ['5', 'Albums'],
      ['6', 'Artists'],
      ['7', 'Podcasts'],
    ],
  );
  // And each of those slots comes back to the section the provider published.
  for (const [index, item] of (root?.items ?? []).entries()) {
    assert.equal(toProviderNode('spotify', 'rudy', String(index)), item.id);
  }
});
