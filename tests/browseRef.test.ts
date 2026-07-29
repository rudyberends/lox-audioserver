import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  decodeBrowseRef,
  encodeContainerRef,
  encodePlayableRef,
  resolveUriFromRef,
} from '../src/domain/media/browseRef';

// A caller round-trips these verbatim: browse hands one out, and it goes back into browse,
// items, or play. So the id has to survive the trip exactly, carry what is needed to act on
// it, and stay valid across restarts and rescans.

test('a container id round-trips', () => {
  const id = encodeContainerRef({ kind: 'album', service: 'applemusic', folderId: 'album:123' });
  assert.deepEqual(decodeBrowseRef(id), {
    target: 'container',
    kind: 'album',
    service: 'applemusic',
    folderId: 'album:123',
  });
});

test('a playable id round-trips, and carries the audiopath so play needs no lookup', () => {
  const audiopath = 'applemusic:track:b64_aS5YTURWZEJRaTI4Z1lRbw==';
  const id = encodePlayableRef({ kind: 'track', audiopath });
  const ref = decodeBrowseRef(id);
  assert.equal(ref?.target, 'playable');
  assert.equal(ref?.target === 'playable' && ref.audiopath, audiopath);
});

test('an audiopath that is itself base64 survives intact', () => {
  // Apple Music ids are base64 with real padding. Losing a trailing `=` would silently
  // produce a different track, which is the kind of bug that only shows up in production.
  for (const audiopath of [
    'applemusic:track:b64_YQ==',
    'applemusic:track:b64_YWI=',
    'applemusic:track:b64_YWJj',
    'library://track/9',
    'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
  ]) {
    const ref = decodeBrowseRef(encodePlayableRef({ kind: 'track', audiopath }));
    assert.equal(ref?.target === 'playable' && ref.audiopath, audiopath, audiopath);
  }
});

test('ids with awkward characters survive', () => {
  // Provider folder ids contain colons, slashes, spaces and non-ASCII; base64url is what
  // keeps them out of the path structure.
  for (const folderId of [
    'a/b/c',
    'genre:hip-hop/trap',
    'Björk — Homogenic',
    'with spaces and & symbols',
    '',
  ]) {
    const ref = decodeBrowseRef(
      encodeContainerRef({ kind: 'folder', service: 'library', folderId }),
    );
    assert.equal(
      ref?.target === 'container' && ref.folderId,
      folderId || 'root',
      JSON.stringify(folderId),
    );
  }
});

test('the kind travels with the id', () => {
  // The whole reason this model beats the Loxone one, whose type number collapses album,
  // artist, playlist and show onto a single value.
  for (const kind of ['album', 'artist', 'playlist', 'show', 'category', 'folder'] as const) {
    const ref = decodeBrowseRef(encodeContainerRef({ kind, service: 'x', folderId: 'y' }));
    assert.equal(ref?.kind, kind);
  }
});

test('a foreign or malformed id is refused, not guessed at', () => {
  // Null rather than a throw, so a mistyped id is a clean 404 instead of a 500.
  for (const id of [
    '',
    'not-an-id',
    'b1',
    'b1.c.album',                       // too few parts
    'b1.c.album.x.y.z',                 // too many
    'b1.x.album.eA.eQ',                 // unknown target
    'b2.c.album.eA.eQ',                 // a future scheme version
    'd.eA.eQ',                          // a Subsonic id
  ]) {
    assert.equal(decodeBrowseRef(id), null, JSON.stringify(id));
  }
});

test('a container id and a playable id are never confused', () => {
  const container = encodeContainerRef({ kind: 'album', service: 's', folderId: 'f' });
  const playable = encodePlayableRef({ kind: 'track', audiopath: 'a' });
  assert.equal(decodeBrowseRef(container)?.target, 'container');
  assert.equal(decodeBrowseRef(playable)?.target, 'playable');
  assert.notEqual(container, playable);
});

// A browse listing hands out ids and the guide promises they round-trip into play. They did
// not: `play` took only a raw audiopath, so browse → play was broken by exactly the route a
// client takes. Our own player reported it as the remaining blocker.

test('a playable browse id resolves to the audiopath play needs', () => {
  const audiopath = 'applemusic:track:b64_YVM1WVRVUldaRUpS==';
  const id = encodePlayableRef({ kind: 'track', audiopath });
  assert.equal(resolveUriFromRef(id), audiopath);
});

test('a raw audiopath is passed through untouched', () => {
  // It has to keep working: it is what favourites, recents and `source.id` report.
  for (const uri of [
    'applemusic:track:b64_YQ==',
    'library://track/9',
    'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
    'http://example/stream.mp3',
    'totally:not:a:thing',
  ]) {
    assert.equal(resolveUriFromRef(uri), uri, uri);
  }
});

test('a container id is not silently turned into something playable', () => {
  // A container ref names a folder and carries no audiopath. Passing it through means it
  // fails downstream as it would have anyway, rather than resolving to the wrong thing.
  const id = encodeContainerRef({ kind: 'album', service: 'applemusic', folderId: 'album:1' });
  assert.equal(resolveUriFromRef(id), id);
});
