import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SpotifyUnavailableLoopGuard } from '../src/adapters/inputs/spotify/spotifyRecoveryPolicy';

test('spotify unavailable loop guard detects rapid distinct unavailable tracks', () => {
  const guard = new SpotifyUnavailableLoopGuard({ windowMs: 10_000, minEvents: 3 });

  assert.equal(guard.recordUnavailable({ trackId: 'one', nowMs: 1_000 }).detected, false);
  assert.equal(guard.recordUnavailable({ trackId: 'two', nowMs: 2_000 }).detected, false);
  const result = guard.recordUnavailable({ trackId: 'three', nowMs: 3_000 });

  assert.equal(result.detected, true);
  assert.equal(result.count, 3);
  assert.equal(result.distinctTracks, 3);
});

test('spotify unavailable loop guard ignores repeated unavailable event for one track', () => {
  const guard = new SpotifyUnavailableLoopGuard({ windowMs: 10_000, minEvents: 3 });

  guard.recordUnavailable({ trackId: 'one', nowMs: 1_000 });
  guard.recordUnavailable({ trackId: 'one', nowMs: 2_000 });
  const result = guard.recordUnavailable({ trackId: 'one', nowMs: 3_000 });

  assert.equal(result.detected, false);
  assert.equal(result.count, 3);
  assert.equal(result.distinctTracks, 1);
});

test('spotify unavailable loop guard requires events inside the detection window', () => {
  const guard = new SpotifyUnavailableLoopGuard({ windowMs: 10_000, minEvents: 3 });

  guard.recordUnavailable({ trackId: 'one', nowMs: 1_000 });
  guard.recordUnavailable({ trackId: 'two', nowMs: 2_000 });
  const result = guard.recordUnavailable({ trackId: 'three', nowMs: 20_000 });

  assert.equal(result.detected, false);
  assert.equal(result.count, 1);
});

test('spotify unavailable loop guard resets after healthy playback progress', () => {
  const guard = new SpotifyUnavailableLoopGuard({ windowMs: 10_000, minEvents: 3 });

  guard.recordUnavailable({ trackId: 'one', nowMs: 1_000 });
  guard.recordUnavailable({ trackId: 'two', nowMs: 2_000 });
  guard.markHealthyProgress('playing', 4);
  const result = guard.recordUnavailable({ trackId: 'three', nowMs: 3_000 });

  assert.equal(result.detected, false);
  assert.equal(result.count, 1);
});
