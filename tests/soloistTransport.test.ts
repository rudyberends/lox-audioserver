import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  buildMirroredQueue,
  classifyTrackChange,
} from '../src/adapters/inputs/spotify/soloist/soloistPlaybackService';
import { mapSpotifyTracksToQueue } from '../src/application/zones/state/spotifyQueueMirror';

/**
 * Soloist keeps a queue of its own no matter who is driving it, so a track this server did not ask
 * for is ambiguous: it is either our track ending or someone reaching for the app's buttons. The
 * queue it reports is what tells those apart.
 */

const queue = { previous: ['spotify:track:a', 'spotify:track:b'] };

test('the track we asked for is ours, whatever the queue says about it', () => {
  assert.equal(classifyTrackChange('spotify:track:c', 'spotify:track:c', queue), 'ours');
  // Even a track that has been played before: playing it again is not a step backwards.
  assert.equal(classifyTrackChange('spotify:track:a', 'spotify:track:a', queue), 'ours');
});

test('a track Soloist has already played means someone pressed back', () => {
  assert.equal(classifyTrackChange('spotify:track:b', 'spotify:track:c', queue), 'back');
});

test('anything else is forward, whether the track ended or was skipped', () => {
  // Both look identical from here, and both mean the same to the queue: this track is over.
  assert.equal(classifyTrackChange('spotify:track:z', 'spotify:track:c', queue), 'forward');
});

test('with nothing asked for there is nothing to have moved past', () => {
  // A zone the app owns outright: every change is the app's business, not a queue step.
  assert.equal(classifyTrackChange('spotify:track:z', null, queue), 'ours');
});

const entry = (id: string, name: string) => ({
  uid: `uid-${id}`,
  source: 'context',
  item: { uri: `spotify:track:${id}`, decorations: { identity: { name } } },
});

test('the current track goes back between what played and what follows', () => {
  const { tracks, currentIndex } = buildMirroredQueue(
    { uri: 'spotify:track:now', title: 'Now' },
    [entry('a', 'A'), entry('b', 'B')],
    [entry('c', 'C')],
  );
  assert.deepEqual(tracks.map((t) => t.title), ['A', 'B', 'Now', 'C']);
  assert.equal(currentIndex, 2);
  assert.equal(tracks[0]!.uid, 'uid-a');
});

test('a queue with nothing either side is just the track playing', () => {
  // What a single track put on from the app looks like, and it must still anchor the zone.
  const { tracks, currentIndex } = buildMirroredQueue({ uri: 'spotify:track:now' }, [], []);
  assert.equal(tracks.length, 1);
  assert.equal(currentIndex, 0);
});

test('the mirrored queue keeps spotify order, ids and covers', () => {
  const items = mapSpotifyTracksToQueue(
    [
      { uri: 'spotify:track:1', uid: 'aa', title: 'One', artist: 'A', album: 'Rec', durationSec: 200 },
      { uri: 'spotify:track:2', uid: 'bb', title: 'Two', coverUrl: 'http://art/2' },
    ],
    'Kitchen',
  );
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((item) => [item.qindex, item.audiopath, item.title, item.unique_id]),
    [
      [0, 'spotify:track:1', 'One', 'aa'],
      [1, 'spotify:track:2', 'Two', 'bb'],
    ],
  );
  assert.equal(items[0]!.duration, 200);
  assert.equal(items[1]!.coverurl, 'http://art/2');
});

test('the same track twice keeps two rows apart', () => {
  // Spotify's own entry handle is what makes them distinct; sharing an id would make removing one
  // of them ambiguous.
  const items = mapSpotifyTracksToQueue(
    [
      { uri: 'spotify:track:1', uid: 'aa', title: 'One' },
      { uri: 'spotify:track:1', uid: 'cc', title: 'One' },
    ],
    'Kitchen',
  );
  assert.notEqual(items[0]!.unique_id, items[1]!.unique_id);
});

test('an entry without a track is left out rather than mirrored empty', () => {
  const items = mapSpotifyTracksToQueue(
    [{ uri: '', title: 'Nothing' }, { uri: 'spotify:track:1', title: 'One' }],
    'Kitchen',
  );
  assert.deepEqual(items.map((item) => item.audiopath), ['spotify:track:1']);
});
