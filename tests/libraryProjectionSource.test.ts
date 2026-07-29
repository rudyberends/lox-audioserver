import assert from 'node:assert/strict';
import { test } from './testHarness';
import { toApiFavorites, toApiRecents } from '../src/adapters/http/api/libraryProjection';
import { buildBridgeRegistry } from '../src/domain/zones/bridgeIdentity';
import type { FavoriteItem } from '../src/application/zones/favorites/types';
import type { RecentItem } from '../src/application/zones/recents/recentsStore';

// The contract says a favourite's and a recent's `source` is what you hand back to `play`.
// It was not: both stores keep whatever audiopath form was in play when the entry was
// written, so entries created while a Loxone client was driving carry that client's Spotify
// disguise. Playing one answers 204 and leaves the zone on "Playback unavailable" — the same
// class of leak as the earlier station/title regressions. Building our own player on this API
// is what surfaced it.

const REGISTRY = buildBridgeRegistry([
  { id: 'bridge-applemusic-abc123', provider: 'applemusic', label: 'Apple Music' },
] as never);

const favorite = (audiopath: string, owner?: string): FavoriteItem =>
  ({ id: 1, slot: 1, plus: true, name: 'A Song', audiopath, type: 'spotify_track', owner }) as FavoriteItem;

const sourceOf = (item: FavoriteItem) =>
  toApiFavorites(3, { items: [item], start: 0, totalitems: 1 }, REGISTRY).items[0]!.source;

test('a bridge-prefixed favourite is reported service-native', () => {
  assert.equal(
    sourceOf(favorite('spotify@bridge-applemusic-abc123:track:xyz')),
    'applemusic:track:xyz',
  );
});

test('the doubled form recents were stored in is unwrapped', () => {
  // Seen live: `spotify@applemusic:applemusic:track:…`. The prefix is not a registered bridge
  // id, so it needs stripping separately — what remains is already native.
  const recents = toApiRecents(
    3,
    { items: [{ audiopath: 'spotify@applemusic:applemusic:track:b64_MTQ0Mw==' } as RecentItem] },
    0,
    10,
    REGISTRY,
  );
  assert.equal(recents.items[0]!.source, 'applemusic:track:b64_MTQ0Mw==');
});

test('a bare spotify path is recovered from the account that stored it', () => {
  // The older, harder case: the disguise was applied without the `@bridge-…` marker, so
  // nothing in the path says otherwise. `owner` names the account, which is the only
  // remaining evidence.
  assert.equal(
    sourceOf(favorite('spotify:track:b64_MTc4MA==', 'bridge-applemusic-abc123')),
    'applemusic:track:b64_MTc4MA==',
  );
});

test('a real Spotify path is left alone', () => {
  // Not everything that says spotify is a disguise, and rewriting a genuine Spotify
  // favourite would break the one case that was working.
  assert.equal(sourceOf(favorite('spotify:track:4uLU6hMCjMI75M1A2tKUQC')), 'spotify:track:4uLU6hMCjMI75M1A2tKUQC');
  assert.equal(sourceOf(favorite('spotify:album:1DFixLWuPkv3KT3TnV35m3')), 'spotify:album:1DFixLWuPkv3KT3TnV35m3');
});

test('an owner that no longer exists is left as it is, not guessed at', () => {
  // Deleting and re-adding a streaming account leaves its favourites pointing at an id that
  // is gone. Those entries genuinely cannot be played, and inventing a service for them would
  // turn an honest failure into a wrong one.
  assert.equal(
    sourceOf(favorite('spotify:track:b64_MTc4MA==', 'bridge-applemusic-deleted')),
    'spotify:track:b64_MTc4MA==',
  );
});

test('a library path and an empty one pass through untouched', () => {
  assert.equal(sourceOf(favorite('library://track/9')), 'library://track/9');
  assert.equal(sourceOf(favorite('')), '');
});
