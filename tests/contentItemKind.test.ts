import assert from 'node:assert/strict';
import { test } from './testHarness';
import { resolveItemKind, isContainerKind } from '../src/adapters/content/contentItemKind';
import { isTrackItem } from '../src/adapters/mediaserver/mediaContentProvider';
import type { ContentFolderItem } from '../src/ports/ContentTypes';

// What an item *is* has to survive to the consumer, because that is the whole reason our
// browse model beats the Loxone one: its FileType number collapses album, artist, playlist
// and show onto a single value. `kind` is what recovers that.

const item = (over: Partial<ContentFolderItem>): ContentFolderItem =>
  ({ id: 'x', name: 'X', type: 1, ...over }) as ContentFolderItem;

test('a radio station is a station, not a track', () => {
  // It used to resolve to `track`: stations are playable files tagged `radio`, and the
  // file check ran before the tag was consulted. That made every station indistinguishable
  // from a song at every consumer, and left `kind: 'radio'` unreachable in practice.
  const station = item({ type: 2, tag: 'radio', audiopath: 'radioparadise:main' });
  assert.equal(resolveItemKind(station), 'radio');
  // Still playable, and still not something to browse into.
  assert.equal(isTrackItem(station), true);
  assert.equal(isContainerKind('radio'), false);
});

test('storage tags still lose to the playable-file check', () => {
  // The local library tags tracks by where they live, which says nothing about what they
  // are — that is why the file check exists at all.
  for (const tag of ['sd', 'nas', 'folder']) {
    assert.equal(
      resolveItemKind(item({ type: 2, tag, audiopath: '/music/a.flac' })),
      'track',
      tag,
    );
  }
});

test('a tag that names a kind wins over the file check', () => {
  for (const [tag, kind] of [
    ['album', 'album'],
    ['artist', 'artist'],
    ['playlist', 'playlist'],
    ['station', 'radio'],
    ['show', 'show'],
    ['episode', 'episode'],
  ] as const) {
    assert.equal(resolveItemKind(item({ type: 2, tag, audiopath: 'x:1' })), kind, tag);
  }
});

test('an explicit kind always wins', () => {
  // Providers are migrating to setting it directly; nothing may override that.
  const explicit = item({ type: 2, tag: 'sd', audiopath: 'x', kind: 'radio' });
  assert.equal(resolveItemKind(explicit), 'radio');
});

test('a container is anything you can browse into', () => {
  for (const kind of ['album', 'artist', 'playlist', 'show', 'category', 'folder'] as const) {
    assert.equal(isContainerKind(kind), true, kind);
  }
  for (const kind of ['track', 'radio', 'episode'] as const) {
    assert.equal(isContainerKind(kind), false, kind);
  }
});

test('a playable item needs somewhere to play from', () => {
  // An album carries an audiopath too ("play the whole thing"), so the kind has to agree.
  assert.equal(isTrackItem(item({ type: 2, tag: 'radio' })), false, 'no audiopath');
  assert.equal(isTrackItem(item({ type: 7, tag: 'album', audiopath: 'x:1' })), false, 'album');
});
