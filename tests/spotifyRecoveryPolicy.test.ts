import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  isCredentialRejection,
  SpotifyUnavailableLoopGuard,
} from '../src/adapters/inputs/spotify/spotifyRecoveryPolicy';

/*
 * The exact wordings from the #333 log. Spotify refuses a stored credentials blob in three places —
 * the Connect device's login, the session behind direct playback, and once per track as the device
 * skips through the queue — and each reports it differently. Recognising all three is what turns an
 * endless retry of a dead blob into minting a new one, so the strings are pinned here.
 */
test('a refused credentials blob is recognised in every wording librespot reports', () => {
  for (const message of [
    'spirc start failed: Invalid state { Login request was denied: INVALID_CREDENTIALS }',
    'Unable to load audio item: Error { kind: FailedPrecondition, error: FaultyRequest(INVALID_CREDENTIALS) }',
    'session connect failed: BadCredentials',
    'bad_credentials',
  ]) {
    assert.equal(isCredentialRejection(message), true, message);
  }
});

test('an ordinary failure is not mistaken for a refused blob', () => {
  for (const message of [
    'connect ECONNREFUSED 10.0.0.5:4070',
    'audio_key_error',
    'HTTP 429 too many requests',
    'bad_request',
    '',
    null,
    undefined,
  ]) {
    assert.equal(isCredentialRejection(message), false, String(message));
  }
});

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
  assert.equal(result.sameTrackRepeats, 3);
});

/*
 * A few failures on one track is that track being unavailable here, and the test above pins that it
 * stays ignored. Hundreds of them in seconds is not a verdict about the track — it is a spin, and in
 * #333 (credentials Spotify refused) it was the same track ~540 times inside six seconds, which
 * flooded the log buffer while `distinctTracks` sat at 1 and nothing ever fired.
 */
test('spotify unavailable loop guard detects one track failing over and over', () => {
  const guard = new SpotifyUnavailableLoopGuard({ windowMs: 10_000, minEvents: 3 });

  let detectedAt = -1;
  for (let i = 0; i < 40; i++) {
    const result = guard.recordUnavailable({ trackId: 'stuck', nowMs: 1_000 + i * 11 });
    if (result.detected) {
      detectedAt = i;
      break;
    }
  }

  assert.equal(detectedAt, 11, 'fires on the 12th repeat inside the window');
});

test('spotify unavailable loop guard counts repeats per track, not across them', () => {
  // Alternating between two tracks must not add up to a single track spinning: each is only
  // failing a handful of times, which is the case the distinct-track rule already covers.
  const guard = new SpotifyUnavailableLoopGuard({
    windowMs: 10_000,
    minEvents: 3,
    minDistinctTracks: 99,
    minSameTrackRepeats: 12,
  });

  let detected = false;
  for (let i = 0; i < 20; i++) {
    const result = guard.recordUnavailable({ trackId: i % 2 ? 'a' : 'b', nowMs: 1_000 + i * 11 });
    detected = detected || result.detected;
  }

  assert.equal(detected, false);
});

test('spotify unavailable loop guard forgets repeats that fall out of the window', () => {
  const guard = new SpotifyUnavailableLoopGuard({ windowMs: 10_000, minEvents: 3 });

  for (let i = 0; i < 11; i++) {
    assert.equal(guard.recordUnavailable({ trackId: 'stuck', nowMs: 1_000 + i * 11 }).detected, false);
  }
  // Same track again, but long enough after that only this one event is still in the window.
  const result = guard.recordUnavailable({ trackId: 'stuck', nowMs: 60_000 });

  assert.equal(result.detected, false);
  assert.equal(result.count, 1);
  assert.equal(result.sameTrackRepeats, 1);
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
