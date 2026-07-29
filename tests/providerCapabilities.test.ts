import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  capabilitiesFor,
  declaredProviders,
  searchCategoriesForLoxone,
} from '../src/adapters/content/providerCapabilities';
import { intersectSearchCategories } from '../src/adapters/content/providerCapabilities';
import { canSearch, canSearchKind, DEFAULT_CAPABILITIES } from '../src/ports/ProviderCapabilities';

// The only capability statement this codebase had was `searchSource: string | null` —
// searchable, or not. Everything finer was asserted: globalsearch/describe handed every
// provider Spotify's six categories, so the app offered an Albums tab on SoundCloud (which
// has never returned one) and five tabs on YouTube (which returns tracks only).

test('a provider that cannot search says so, rather than claiming Spotify\'s set', () => {
  // Read off each provider's own search() implementation: the keys it assigns are the kinds
  // it can serve. These are the three that describe used to overstate.
  assert.deepEqual([...capabilitiesFor('youtube').search], ['track']);
  assert.deepEqual([...capabilitiesFor('ytmusic').search], ['track']);
  assert.ok(!canSearchKind(capabilitiesFor('soundcloud'), 'album'), 'soundcloud has no albums');
  assert.ok(canSearchKind(capabilitiesFor('soundcloud'), 'playlist'), 'but it does have those');
});

test('spotify is the only provider that reaches podcasts', () => {
  // Its Pathfinder search covers music; shows and episodes fall through to the Web API.
  assert.ok(canSearchKind(capabilitiesFor('spotify'), 'show'));
  for (const provider of ['applemusic', 'deezer', 'tidal', 'soundcloud', 'ytmusic']) {
    assert.ok(!canSearchKind(capabilitiesFor(provider), 'show'), provider);
  }
});

test('an unknown provider is under-advertised, not credited with features', () => {
  // A new provider offering fewer features than it has is a missed opportunity; one
  // offering a feature that fails is a bug the user sees.
  const unknown = capabilitiesFor('some-new-service');
  assert.deepEqual(unknown, DEFAULT_CAPABILITIES);
  assert.equal(canSearch(unknown), false);
  assert.equal(unknown.browse, true, 'browsable is the safe assumption');
});

test('the provider name is matched forgivingly', () => {
  for (const spelling of ['Spotify', ' spotify ', 'SPOTIFY']) {
    assert.ok(canSearch(capabilitiesFor(spelling)), spelling);
  }
  assert.deepEqual(capabilitiesFor(undefined), DEFAULT_CAPABILITIES);
  assert.deepEqual(capabilitiesFor(''), DEFAULT_CAPABILITIES);
});

test('a streaming catalogue is distinguished from a local collection', () => {
  // What the Subsonic adapter otherwise has to guess: "every artist on Tidal" is not an
  // enumerable list, so an ID3 view has to show the user's collection instead.
  for (const streaming of ['spotify', 'applemusic', 'deezer', 'tidal', 'soundcloud']) {
    assert.equal(capabilitiesFor(streaming).catalogueExceedsLibrary, true, streaming);
  }
  assert.equal(capabilitiesFor('library').catalogueExceedsLibrary, false);
});

test('every declared provider is internally consistent', () => {
  // A row that lists search kinds but is unsearchable, or vice versa, would make the two
  // accessors disagree.
  for (const provider of declaredProviders()) {
    const caps = capabilitiesFor(provider);
    assert.equal(canSearch(caps), caps.search.length > 0, provider);
    assert.equal(new Set(caps.search).size, caps.search.length, `${provider} has duplicates`);
  }
});

test('the Loxone app keeps its own word for a station', () => {
  // It says `station` where we say `radio`; translating here keeps the wire compatible
  // while the capability stays declared in one place.
  assert.deepEqual(searchCategoriesForLoxone('tunein'), ['station']);
  assert.deepEqual(searchCategoriesForLoxone('youtube'), ['track']);
  assert.deepEqual(searchCategoriesForLoxone('radioparadise'), []);
});

// The Loxone app has one `spotify` source standing for every bridged service, because it
// knows no other streaming source. So whatever that entry promises has to hold for all of
// them at once.

test('the shared spotify entry promises only what every bridge can deliver', () => {
  // Apple Music has no podcasts and SoundCloud has no albums, so a user with both should
  // be offered neither tab.
  assert.deepEqual(intersectSearchCategories(['applemusic', 'soundcloud']), [
    'track',
    'artist',
    'playlist',
  ]);
  // On its own, Apple Music keeps its albums.
  assert.ok(intersectSearchCategories(['applemusic']).includes('album'));
});

test('an intersection with a tracks-only provider collapses to tracks', () => {
  assert.deepEqual(intersectSearchCategories(['applemusic', 'youtube']), ['track']);
});

test('providers with nothing in common promise nothing', () => {
  // Better an empty search surface than tabs that cannot fill.
  assert.deepEqual(intersectSearchCategories(['youtube', 'tunein']), []);
  assert.deepEqual(intersectSearchCategories([]), []);
});
