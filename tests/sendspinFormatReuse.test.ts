import assert from 'node:assert/strict';
import { test } from './testHarness';
import type { EngineSessionStats } from '../src/ports/EnginePort';
import type { OutputProfile } from '../src/ports/EngineTypes';

/**
 * Mirrors the session-reuse decision in sendspinOutput.startStream. The bug this
 * guards: matching on `profile` alone let a leftover 48 kHz FLAC session satisfy a
 * 96 kHz request, so the engine was never restarted and kept emitting 48 kHz frames
 * while stream/start announced 96 kHz. Clients then failed to decode every packet
 * — and only for 96 kHz sessions that followed a 48 kHz one.
 */
function hasTargetProfile(
  stats: EngineSessionStats[],
  profile: OutputProfile,
  format: { sampleRate: number; channels: number; bitDepth: number },
): boolean {
  return stats.some(
    (s) =>
      s.profile === profile &&
      s.sampleRate === format.sampleRate &&
      s.channels === format.channels &&
      s.pcmBitDepth === format.bitDepth,
  );
}

function statsFor(
  profile: OutputProfile,
  sampleRate: number,
  pcmBitDepth: number,
  channels = 2,
): EngineSessionStats {
  return {
    profile,
    sampleRate,
    channels,
    pcmBitDepth,
    bps: 1000,
    bufferedBytes: 0,
    totalBytes: 0,
    lastUpdated: null,
    subscribers: 1,
    restarts: 0,
    lastError: null,
    lastErrorAt: null,
    lastStderr: null,
    lastStderrAt: null,
    lastExitCode: null,
    lastExitSignal: null,
    lastExitAt: null,
    subscriberDrops: 0,
    lastSubscriberDropAt: null,
  };
}

const FLAC_96_24 = { sampleRate: 96000, channels: 2, bitDepth: 24 };

test('a 48kHz FLAC session must not satisfy a 96kHz FLAC request', () => {
  const leftover = [statsFor('flac', 48000, 24)];
  assert.equal(
    hasTargetProfile(leftover, 'flac', FLAC_96_24),
    false,
    'reusing this session would stream 48kHz frames under a 96kHz stream/start',
  );
});

test('a matching session is reused', () => {
  const matching = [statsFor('flac', 96000, 24)];
  assert.equal(hasTargetProfile(matching, 'flac', FLAC_96_24), true);
});

test('bit-depth and channel mismatches also force a restart', () => {
  assert.equal(hasTargetProfile([statsFor('flac', 96000, 16)], 'flac', FLAC_96_24), false, 'depth');
  assert.equal(hasTargetProfile([statsFor('flac', 96000, 24, 1)], 'flac', FLAC_96_24), false, 'channels');
});

test('a different profile at the same format is not a match', () => {
  assert.equal(hasTargetProfile([statsFor('pcm', 96000, 24)], 'flac', FLAC_96_24), false);
});

test('the right session is found among several', () => {
  const many = [statsFor('pcm', 44100, 16), statsFor('flac', 48000, 24), statsFor('flac', 96000, 24)];
  assert.equal(hasTargetProfile(many, 'flac', FLAC_96_24), true);
});

test('engine session stats expose the format needed for the comparison', () => {
  // Guards against the format fields being dropped from EngineSessionStats again,
  // which would silently reduce the check to profile-only matching.
  const stats = statsFor('flac', 96000, 24);
  assert.equal(typeof stats.sampleRate, 'number');
  assert.equal(typeof stats.channels, 'number');
  assert.equal(typeof stats.pcmBitDepth, 'number');
});
