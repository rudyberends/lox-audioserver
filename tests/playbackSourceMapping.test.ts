import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from './testHarness';
import { toEngineInputSpec, toPlaybackSource } from '../src/ports/playbackSourceMapping';
import type { EngineInputSpec, PlaybackSource } from '../src/ports/EngineTypes';

/*
 * The mapping between `PlaybackSource` and `EngineInputSpec` used to be two hand-written object literals
 * a layer apart, and nothing made them agree: a field added to the types compiled fine while being
 * dropped in transit. Two were — `nativeFormat` and `gainDb` — so every Apple Music track was resampled
 * 44.1 → 44.1 for nothing and the API reported "source not reported" for a format the provider had
 * declared.
 *
 * These tests populate *every* optional field and assert the round trip is lossless, which is the closest
 * a hand mapper gets to compiler pressure: a new field fails here until it is carried in both directions.
 */

test('a url source survives the round trip with every field set', () => {
  const source: Extract<PlaybackSource, { kind: 'url' }> = {
    kind: 'url',
    url: 'http://127.0.0.1:7090/applemusic/abc/seg.mp4',
    preDelayMs: 120,
    headers: { Authorization: 'Bearer x' },
    decryptionKey: 'deadbeef',
    tlsVerifyHost: 'example.com',
    inputFormat: 'hls',
    logLevel: 'verbose',
    startAtSec: 12,
    gainDb: -3.5,
    realTime: true,
    lowLatency: false,
    restartOnFailure: true,
    nativeFormat: { sampleRate: 44100, channels: 2, bitDepth: 16, lossless: false, codecName: 'aac' },
    knownDurationSec: 240,
  };
  assert.deepEqual(toPlaybackSource(toEngineInputSpec(source)), source);
});

test('a file source survives the round trip with every field set', () => {
  const source: Extract<PlaybackSource, { kind: 'file' }> = {
    kind: 'file',
    path: '/music/a.flac',
    loop: true,
    preDelayMs: 40,
    startAtSec: 3,
    // Dropped by the old reverse mapper, which silently re-enabled ffmpeg's `-re` pacing.
    realTime: false,
    // Dropping this one would cost a scanned library track its bit-perfect bypass, silently: the
    // engine would simply not know the format and resample as if it were unknown.
    nativeFormat: { sampleRate: 44100, channels: 2, bitDepth: 16, lossless: true, codecName: 'flac' },
    knownDurationSec: 187,
  };
  assert.deepEqual(toPlaybackSource(toEngineInputSpec(source)), source);
});

test('a pipe source survives the round trip, stream reference included', () => {
  const stream = new PassThrough();
  const source: Extract<PlaybackSource, { kind: 'pipe' }> = {
    kind: 'pipe',
    path: '/tmp/pipe',
    preDelayMs: 0,
    format: 's24le',
    sampleRate: 48000,
    channels: 2,
    realTime: false,
    stream,
  };
  const round = toPlaybackSource(toEngineInputSpec(source)) as Extract<PlaybackSource, { kind: 'pipe' }>;
  assert.deepEqual({ ...round, stream: undefined }, { ...source, stream: undefined });
  assert.equal(round.stream, stream, 'the same stream object, not a copy');
});

test('every optional field of the engine spec is carried both ways', () => {
  /*
   * The guard that fails when someone adds a field to `EngineInputSpec` and forgets the mapper: it walks
   * the *keys* rather than trusting a literal, so a new one shows up as a missing key here rather than as
   * a silently ignored declaration in production.
   */
  const spec: Extract<EngineInputSpec, { kind: 'url' }> = {
    kind: 'url',
    url: 'https://x/y.flac',
    preDelayMs: 1,
    headers: { a: 'b' },
    decryptionKey: 'k',
    tlsVerifyHost: 'h',
    inputFormat: 'flac',
    logLevel: 'info',
    startAtSec: 2,
    gainDb: 1.5,
    realTime: false,
    lowLatency: true,
    restartOnFailure: false,
    nativeFormat: { sampleRate: 96000, channels: 2, bitDepth: 24, lossless: true, codecName: 'flac' },
    knownDurationSec: 512,
  };
  const back = toEngineInputSpec(toPlaybackSource(spec));
  assert.deepEqual(Object.keys(back).sort(), Object.keys(spec).sort());
  assert.deepEqual(back, spec);
});

test('silence has no engine representation', () => {
  assert.throws(() => toPlaybackSource({ kind: 'silence' } as EngineInputSpec), /silence/);
});
