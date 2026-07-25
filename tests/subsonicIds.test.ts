import assert from 'node:assert/strict';
import { test } from './testHarness';
import { collectionNoun } from '../src/adapters/subsonic/subsonicCatalog';
import {
  decodeEntityId,
  encodeContainerId,
  encodeSongId,
  musicFolderId,
  retagContainerId,
} from '../src/adapters/subsonic/subsonicIds';

test('subsonic ids: containers round-trip service and folder id', () => {
  const id = encodeContainerId('dir', 'bridge-applemusic-p0gngd', 'library:album:local|Artist|Album');
  const ref = decodeEntityId(id);
  assert.deepEqual(ref, {
    kind: 'dir',
    service: 'bridge-applemusic-p0gngd',
    folderId: 'library:album:local|Artist|Album',
  });
});

test('subsonic ids: each container tag decodes to its own kind', () => {
  for (const kind of ['dir', 'artist', 'album', 'playlist'] as const) {
    const ref = decodeEntityId(encodeContainerId(kind, 'library', 'root'));
    assert.equal(ref?.kind, kind, `expected ${kind}`);
  }
});

test('subsonic ids: songs round-trip the audiopath', () => {
  const audiopath = 'spotify:track:b64_c3BvdGlmeTp0cmFjazoxMjM=';
  const ref = decodeEntityId(encodeSongId(audiopath));
  assert.deepEqual(ref, { kind: 'song', audiopath });
});

test('subsonic ids: song ids are distinguishable from container ids', () => {
  // A container id carries a service segment; a song id never does. Clients feed
  // ids back to whichever endpoint they came from, so the two must not collide.
  const song = decodeEntityId(encodeSongId('library://a/b.mp3'));
  const container = decodeEntityId(encodeContainerId('album', 'library', 'library-local-albums'));
  assert.equal(song?.kind, 'song');
  assert.equal(container?.kind, 'album');
});

test('subsonic ids: ids survive characters that need escaping in URLs and XML', () => {
  // Provider folder ids routinely carry &, ?, / and spaces; base64url keeps the
  // id free of anything that would need escaping on the wire.
  const folderId = 'search?q=a&b=c /deep path/#frag';
  const id = encodeContainerId('dir', 'radio', folderId);
  assert.match(id, /^[A-Za-z0-9\-_.]+$/);
  assert.equal(decodeEntityId(id)?.kind === 'song' ? null : decodeEntityId(id)?.folderId, folderId);
});

test('subsonic ids: malformed ids decode to null rather than throwing', () => {
  assert.equal(decodeEntityId(''), null);
  assert.equal(decodeEntityId('   '), null);
  // Unknown tag.
  assert.equal(decodeEntityId('zz.aGk.aGk'), null);
  // Container tag with a missing segment.
  assert.equal(decodeEntityId('al.aGk'), null);
  // Song tag with too many segments.
  assert.equal(decodeEntityId('t.aGk.aGk'), null);
});

test('subsonic ids: retag keeps the target while changing the entity kind', () => {
  const ref = decodeEntityId(encodeContainerId('dir', 'library', 'library-local-albums'));
  assert.ok(ref);
  const asAlbum = retagContainerId(ref, 'album');
  assert.ok(asAlbum);
  const decoded = decodeEntityId(asAlbum);
  assert.equal(decoded?.kind, 'album');
  assert.equal(decoded?.kind === 'song' ? null : decoded?.folderId, 'library-local-albums');
});

test('subsonic ids: retag refuses a song id', () => {
  const ref = decodeEntityId(encodeSongId('library://a.mp3'));
  assert.ok(ref);
  assert.equal(retagContainerId(ref, 'album'), null);
});

test('subsonic ids: music folder ids are stable, positive and order-independent', () => {
  // Clients persist musicFolderId, so the value must depend only on the service
  // key — not on config order, which an array index would have leaked.
  const first = musicFolderId('bridge-tidal-abc');
  assert.equal(first, musicFolderId('bridge-tidal-abc'));
  assert.ok(first > 0, 'must be positive');
  assert.ok(Number.isSafeInteger(first));
  assert.notEqual(first, musicFolderId('bridge-tidal-abd'));
  assert.notEqual(musicFolderId('library'), musicFolderId('radio'));
});

// ── Collection-folder matching ──────────────────────────────────────────────
// Providers decorate their collection folders differently ("Albums", "My
// Playlists", "Your Likes"), so the possessive prefix is stripped before the
// noun is matched. Getting this wrong makes a bridge look empty in ID3 mode.

test('subsonic collections: possessive prefixes are stripped before matching', () => {
  assert.equal(collectionNoun('Albums'), 'Albums');
  assert.equal(collectionNoun('My Playlists'), 'Playlists');
  assert.equal(collectionNoun('Your Likes'), 'Likes');
  assert.equal(collectionNoun('Saved Albums'), 'Albums');
  assert.equal(collectionNoun('Followed Artists'), 'Artists');
  assert.equal(collectionNoun('  Your Playlists  '), 'Playlists');
});

test('subsonic collections: unrelated folder names are left intact', () => {
  // "New Releases" and "Top 50" are browsable, but they are not the user's own
  // collection and must not be mistaken for one.
  assert.equal(collectionNoun('New Releases'), 'New Releases');
  assert.equal(collectionNoun('Top 50'), 'Top 50');
  assert.equal(collectionNoun('Genres & Moods'), 'Genres & Moods');
});
