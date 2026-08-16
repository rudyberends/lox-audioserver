import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  buildMirroredQueue,
  classifyTrackChange,
  classifyVolumeReport,
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

/**
 * The volume in the Spotify app reaches the room by way of the zone's own volume, so the only
 * question is which of the levels Soloist reports is somebody actually asking for something.
 */

const NOW = 1_000_000;

test('a level nobody here set is somebody moving the slider', () => {
  const verdict = classifyVolumeReport({ level: 55, agreed: null, latch: null, now: NOW });
  assert.equal(verdict.follow, true);
  assert.equal(verdict.reason, 'listener');
});

test('the level we just told soloist about comes straight back and is not a change', () => {
  // Every `set_volume` of ours is echoed as a `volume_changed`. Following it would put the level
  // back on the zone, which pushes it out again — the two would chase each other.
  const verdict = classifyVolumeReport({ level: 40, agreed: 40, latch: null, now: NOW });
  assert.equal(verdict.follow, false);
  assert.equal(verdict.reason, 'echo');
});

test('the volume connect hands a device on activation is dropped, and so are its repeats', () => {
  // Picking a room in the app announces the level Spotify remembered for it, more than once and
  // all within a moment. The zone's own default has to survive that.
  const latch = { until: NOW + 4000, value: null };
  const first = classifyVolumeReport({ level: 100, agreed: null, latch, now: NOW + 10 });
  assert.equal(first.follow, false);
  assert.equal(first.reason, 'activation');
  assert.equal(first.latch?.value, 100);

  // Long after the window, the same value is still Connect's rather than anyone's hand.
  const later = classifyVolumeReport({
    level: 100,
    agreed: null,
    latch: first.latch,
    now: NOW + 60_000,
  });
  assert.equal(later.follow, false);
  assert.equal(later.reason, 'activation');
});

test('a different level during the handshake burst is still not a listener', () => {
  // The burst can carry more than one value, and none of them is somebody reaching for the app.
  const verdict = classifyVolumeReport({
    level: 70,
    agreed: null,
    latch: { until: NOW + 4000, value: 100 },
    now: NOW + 500,
  });
  assert.equal(verdict.follow, false);
  assert.equal(verdict.reason, 'activation');
  // The value first seen is kept: it is the one whose repeats have to stay recognisable.
  assert.equal(verdict.latch?.value, 100);
});

test('moving the slider after the window releases the latch for good', () => {
  const verdict = classifyVolumeReport({
    level: 35,
    agreed: null,
    latch: { until: NOW + 4000, value: 100 },
    now: NOW + 5000,
  });
  assert.equal(verdict.follow, true);
  assert.equal(verdict.reason, 'listener');
  assert.equal(verdict.latch, null);
});

test('a latch that never saw a value stops guarding when its window closes', () => {
  // Measured: on a real start the burst either never arrives or arrives while the track is still
  // being set up, where events are ignored regardless. Holding the latch open for it costs the
  // first genuine turn of the knob, which is the one thing that must not be lost.
  const verdict = classifyVolumeReport({
    level: 55,
    agreed: null,
    latch: { until: NOW + 4000, value: null },
    now: NOW + 5000,
  });
  assert.equal(verdict.follow, true);
  assert.equal(verdict.reason, 'listener');
});
