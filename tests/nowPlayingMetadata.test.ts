import assert from 'node:assert/strict';
import { test } from './testHarness';
import { selectQueuePlaybackMetadata } from '../src/application/zones/playback/nowPlayingMetadata';

test('now-playing prefers the queue track over a container seed', () => {
  // Artist favourite: the play request is seeded with the container ("Queen"),
  // but the queue's current item is the actual track.
  const meta = selectQueuePlaybackMetadata(
    { title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', coverurl: 'cover/track', duration: 354 },
    { title: 'Queen', artist: '', album: '', coverurl: 'cover/artist' },
    { itemFirst: true, fallbackTitle: 'Zone' },
  );
  assert.equal(meta.title, 'Bohemian Rhapsody');
  assert.equal(meta.artist, 'Queen');
  assert.equal(meta.album, 'A Night at the Opera');
  assert.equal(meta.coverurl, 'cover/track');
  assert.equal(meta.duration, 354);
});

test('now-playing falls back to enriched values when the track field is empty (radio)', () => {
  // Radio queue items carry empty titles; metadata is resolved into `enriched`.
  const meta = selectQueuePlaybackMetadata(
    { title: '', artist: '', album: '', coverurl: '', duration: 0 },
    { title: 'Station X — Now', artist: 'Some DJ', album: '', coverurl: 'cover/station', duration: 0 },
    { itemFirst: true, fallbackTitle: 'Zone' },
  );
  assert.equal(meta.title, 'Station X — Now');
  assert.equal(meta.artist, 'Some DJ');
  assert.equal(meta.coverurl, 'cover/station');
});

test('now-playing keeps enriched first for youtube/ytmusic placeholders', () => {
  // itemFirst=false: a "Loading…" queue title must not win over the resolved one.
  const meta = selectQueuePlaybackMetadata(
    { title: 'Loading…', artist: '', album: '', coverurl: '', duration: 0 },
    { title: 'Real Title', artist: 'Real Artist', album: '', coverurl: 'cover/yt', duration: 200 },
    { itemFirst: false, fallbackTitle: 'Zone' },
  );
  assert.equal(meta.title, 'Real Title');
  assert.equal(meta.artist, 'Real Artist');
  assert.equal(meta.duration, 200);
});

test('now-playing uses the fallback title when nothing is available', () => {
  const meta = selectQueuePlaybackMetadata(
    { title: '', artist: '', album: '' },
    undefined,
    { itemFirst: true, fallbackTitle: 'Living Room' },
  );
  assert.equal(meta.title, 'Living Room');
  assert.equal(meta.artist, '');
});
