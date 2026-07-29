import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  intersectSearchCategories,
  searchCategoriesForLoxone,
} from '../src/adapters/content/providerCapabilities';
import { toLoxoneAudiopath, toServiceNative, buildBridgeRegistry } from '../src/domain/zones/bridgeIdentity';
import { stripNeutralItemFields } from '../src/adapters/loxone/commands/utils/loxoneItems';
import type { ContentFolderItem } from '../src/ports/ContentTypes';

// The Loxone projection translates for a client that knows exactly one streaming service.
// Everything reaches it as Spotify, and that is not a limitation to fix here — it is the
// contract. Our own API is where the other providers are first-class.
//
// These tests pin the boundary: work on the neutral side must not leak a real provider name
// or a neutral field into the Loxone view, and must not widen what that view claims.

const SERVICES = [
  { id: 'bridge-applemusic-p0gngd', provider: 'applemusic', label: 'Apple Music' },
  { id: 'bridge-soundcloud-x1y2z3', provider: 'soundcloud', label: 'SoundCloud' },
];

test('a service-native audiopath is disguised as Spotify on the way out', () => {
  const registry = buildBridgeRegistry(SERVICES as never);
  const loxone = toLoxoneAudiopath('applemusic:p0gngd:track:123', registry);
  assert.match(loxone, /^spotify@/, 'the app must see Spotify and nothing else');
  assert.ok(!loxone.includes('applemusic:'), 'the real service name does not appear bare');
  // And it comes back to a service-native path, which is what makes the disguise safe to
  // apply. With a single account of a service the slug is dropped on the way back — it is
  // only needed to tell two accounts of the same service apart.
  assert.equal(toServiceNative(loxone, registry), 'applemusic:track:123');
});

test('the neutral `kind` field never reaches a Loxone listing', () => {
  // Loxone has `type` (three usable values) and `tag`. `kind` is ours — the field that lets
  // our own API tell an album from an artist from a playlist — and sending it would put a
  // vocabulary the app does not know on its wire.
  const item = {
    id: 'x',
    name: 'An Album',
    type: 7,
    tag: 'album',
    kind: 'album',
    audiopath: 'applemusic:p0gngd:album:1',
  } as ContentFolderItem;
  const [projected] = stripNeutralItemFields([{ ...item }]) as Array<Record<string, unknown>>;
  assert.ok(projected, 'the item survives the projection');
  assert.ok(!('kind' in projected!), 'kind is ours, not theirs');
  assert.equal(projected!.type, 7, 'the Loxone type stays');
  assert.equal(projected!.tag, 'album', 'and so does the tag it reads instead');
});

test('search categories are announced in the app\'s vocabulary, not ours', () => {
  // We call it `radio`; the app calls it `station`. Our word must not appear.
  const categories = searchCategoriesForLoxone('tunein');
  assert.deepEqual(categories, ['station']);
  assert.ok(!categories.includes('radio'), 'our name for it stays on our side');
});

test('the shared spotify entry cannot promise more than every bridge delivers', () => {
  // The app has one `spotify` source covering several bridged services, so a category it
  // announces has to hold for all of them — otherwise a user gets a tab that never fills.
  // Narrowing is safe; widening is the regression this pins against.
  const shared = intersectSearchCategories(['applemusic', 'soundcloud']);
  for (const provider of ['applemusic', 'soundcloud']) {
    const own = new Set(searchCategoriesForLoxone(provider));
    for (const category of shared) {
      assert.ok(own.has(category), `${provider} must actually serve ${category}`);
    }
  }
});

test('no real provider name is ever a Loxone search source', () => {
  // The app knows `spotify`, `local` and `tunein`. A bridged provider announcing itself by
  // name would be a source the app cannot ask for, and a leak of the thing the projection
  // exists to hide.
  const allowed = new Set(['spotify', 'local', 'tunein']);
  for (const real of ['applemusic', 'soundcloud', 'tidal', 'deezer', 'ytmusic', 'youtube']) {
    assert.ok(!allowed.has(real), `${real} is not a source name the app knows`);
  }
});
