import assert from 'node:assert/strict';
import { test } from './testHarness';
import { toApiAudioFormat, toStreamFormat } from '../src/adapters/http/api/streamFormat';
import type { EngineSessionStats } from '../src/ports/EnginePort';

// Sendspin already shows its client the codec, rate, depth and channel count, and the admin
// UI has had it in `tech` all along — but a player on the public API could not tell a listener
// what they were hearing.

const stat = (over: Partial<EngineSessionStats>): EngineSessionStats =>
  ({
    // Same instant unless a test says otherwise: siblings, not replacements.
    startedAt: 1_000,
    profile: 'pcm',
    sampleRate: 44100,
    channels: 2,
    pcmBitDepth: 16,
    bps: null,
    bitPerfect: false,
    dspApplied: false,
    subscribers: 1,
    bufferedBytes: 0,
    totalBytes: 0,
    lastUpdated: null,
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
    ...over,
  }) as EngineSessionStats;

test('the format describes the audio, not the engine', () => {
  const format = toStreamFormat([
    stat({
      sampleRate: 192000,
      pcmBitDepth: 24,
      sourceFormat: { codec: 'flac', sampleRate: 192000, channels: 2, bitDepth: 24, bitrate: null },
    }),
  ]);
  assert.deepEqual(format, {
    codec: 'pcm',
    sampleRate: 192000,
    bitDepth: 24,
    channels: 2,
    bitrate: 192000 * 2 * 24,
    // Backed by the source: 192 kHz/24-bit FLAC in, so the numbers on the way out mean something. The
    // same output with no reported source makes no claim — see the test below.
    highRes: true,
  });
  // Buffer sizes, restart counts and subscriber drops are engine health and stay out.
  assert.deepEqual(Object.keys(format!).sort(), [
    'bitDepth',
    'bitrate',
    'channels',
    'codec',
    'highRes',
    'sampleRate',
  ]);
});

test('the API format separates native source audio from output audio', () => {
  const format = toApiAudioFormat([
    stat({
      sampleRate: 44100,
      pcmBitDepth: 24,
      sourceFormat: {
        codec: 'flac',
        sampleRate: 96000,
        channels: 2,
        bitDepth: 24,
        bitrate: null,
      },
    }),
  ]);
  assert.deepEqual(format, {
    bitPerfect: false,
    dspApplied: false,
    source: {
      codec: 'flac',
      sampleRate: 96000,
      channels: 2,
      bitDepth: 24,
      bitrate: null,
      highRes: true,
    },
    output: {
      codec: 'pcm',
      sampleRate: 44100,
      channels: 2,
      bitDepth: 24,
      bitrate: 44100 * 2 * 24,
      highRes: true,
    },
    // Null rather than a chain of `false`: a session that did not describe its stages and a session
    // that did nothing are different claims, and the player renders them differently.
    processing: null,
  });
});

test('the API reports the engine chain, with crossfade merged in from the session', () => {
  const format = toApiAudioFormat([
    stat({
      profile: 'flac',
      sampleRate: 48000,
      pcmBitDepth: 16,
      dspApplied: true,
      crossfading: true,
      processing: {
        resampled: true,
        resampler: { name: 'soxr', precision: 28, cutoff: 0.97 },
        requantised: true,
        channelsRemapped: false,
        reencoded: false,
        equalizer: { bands: [0, 2, 0, 0, 0, 0, 0, -1, 0, 0] },
        gainDb: { source: -3.2, output: 0 },
        delayMs: 120,
      },
      sourceFormat: {
        codec: 'flac',
        sampleRate: 96000,
        channels: 2,
        bitDepth: 24,
        bitrate: null,
      },
    }),
  ]);
  assert.deepEqual(format?.processing, {
    resampled: true,
    resampler: { name: 'soxr', precision: 28, cutoff: 0.97 },
    requantised: true,
    channelsRemapped: false,
    reencoded: false,
    equalizer: { bands: [0, 2, 0, 0, 0, 0, 0, -1, 0, 0] },
    gainDb: { source: -3.2, output: 0 },
    delayMs: 120,
    // Not part of the arg builder's description — it is a state of the session, not a configuration —
    // so the projection is where the two meet.
    crossfading: true,
  });
});

test('a replacement session wins over the one it replaced', () => {
  // Starting a 192 kHz file in a zone whose stored format is 48 kHz leaves both alive for a moment: the
  // manager starts at 48, the output restarts at 192. The newer object is the survivor, and describing
  // the older one is how a hi-res FLAC came out as "48 kHz".
  const format = toApiAudioFormat([
    stat({
      startedAt: 1_000,
      profile: 'pcm',
      sampleRate: 48000,
      pcmBitDepth: 24,
      sourceFormat: { codec: 'flac', sampleRate: 192000, channels: 2, bitDepth: 24, bitrate: null },
    }),
    stat({
      startedAt: 1_400,
      profile: 'pcm',
      sampleRate: 192000,
      pcmBitDepth: 24,
      sourceFormat: { codec: 'flac', sampleRate: 192000, channels: 2, bitDepth: 24, bitrate: null },
    }),
  ]);
  assert.equal(format?.output.sampleRate, 192000);
});

test('a lower-rate replacement still wins — newest is the survivor, not the best', () => {
  // The same mechanism in reverse: a 44.1 kHz track started after a 192 kHz one. Preferring the higher
  // rate here would keep describing the track that already stopped.
  const format = toApiAudioFormat([
    stat({ startedAt: 5_000, profile: 'pcm', sampleRate: 192000, pcmBitDepth: 24 }),
    stat({ startedAt: 5_900, profile: 'pcm', sampleRate: 44100, pcmBitDepth: 24 }),
  ]);
  assert.equal(format?.output.sampleRate, 44100);
});

test('profiles started together are compared on their audio, not their clock', () => {
  // A Cast device on MP3 beside sendspin on PCM: milliseconds apart, so the rate decides.
  const format = toApiAudioFormat([
    stat({ startedAt: 9_000, profile: 'mp3', sampleRate: 44100, pcmBitDepth: 16, bps: 32000 }),
    stat({ startedAt: 9_020, profile: 'pcm', sampleRate: 96000, pcmBitDepth: 24 }),
  ]);
  assert.equal(format?.output.codec, 'pcm');
  assert.equal(format?.output.sampleRate, 96000);
});

test('a 24-bit container around a lossy source is not high-res', () => {
  // The case that started this: Apple Music's AAC decoded into the PCM sink, which carries 24-bit
  // samples. Every number in the output format says "better than CD" and none of the audio does.
  const format = toApiAudioFormat([
    stat({
      profile: 'pcm',
      sampleRate: 44100,
      pcmBitDepth: 24,
      sourceFormat: { codec: 'aac', sampleRate: 44100, channels: 2, bitDepth: null, bitrate: 256000 },
    }),
  ]);
  assert.equal(format?.output.highRes, false, 'padding is not resolution');
  assert.equal(format?.source?.highRes, false, 'a lossy source is never high-res');
});

test('depth surviving a rate reduction is still high-res', () => {
  const format = toApiAudioFormat([
    stat({
      profile: 'flac',
      sampleRate: 48000,
      pcmBitDepth: 24,
      sourceFormat: { codec: 'flac', sampleRate: 96000, channels: 2, bitDepth: 24, bitrate: null },
    }),
  ]);
  assert.equal(format?.output.highRes, true, '24 bits survived, so the output is still better than CD');
  assert.equal(format?.source?.highRes, true);
});

test('upsampling a CD-rate lossless source does not make it high-res', () => {
  const format = toApiAudioFormat([
    stat({
      profile: 'pcm',
      sampleRate: 96000,
      pcmBitDepth: 16,
      sourceFormat: { codec: 'flac', sampleRate: 44100, channels: 2, bitDepth: 16, bitrate: null },
    }),
  ]);
  assert.equal(format?.output.highRes, false, 'the extra samples were invented');
});

test('without a reported source the output makes no high-res claim', () => {
  const format = toApiAudioFormat([
    stat({ profile: 'pcm', sampleRate: 96000, pcmBitDepth: 24, sourceFormat: null }),
  ]);
  assert.equal(format?.output.highRes, false, 'a claim that cannot be backed is not made');
});

test('the API exposes the engine bit-perfect decision', () => {
  const format = toApiAudioFormat([
    stat({
      profile: 'pcm',
      sampleRate: 192000,
      channels: 2,
      pcmBitDepth: 24,
      bitPerfect: true,
    }),
  ]);
  assert.equal(format?.bitPerfect, true);
  assert.equal(format?.dspApplied, false);
});

test('a zone streaming nothing has no format', () => {
  assert.equal(toStreamFormat([]), null);
  // A session with no negotiated rate is not something to report either.
  assert.equal(toStreamFormat([stat({ sampleRate: 0 })]), null);
});

test('the profile someone is listening to wins over one nobody pulls', () => {
  // A zone can hold several encoded profiles at once — a Cast device on MP3 while sendspin
  // takes PCM — and only one of them is what a listener hears.
  const format = toStreamFormat([
    stat({ profile: 'mp3', sampleRate: 48000, subscribers: 0 }),
    stat({ profile: 'flac', sampleRate: 44100, subscribers: 2 }),
  ]);
  assert.equal(format?.codec, 'flac');
});

test('with several live profiles the most informative one is reported', () => {
  const format = toStreamFormat([
    stat({ profile: 'mp3', sampleRate: 44100, subscribers: 1 }),
    stat({ profile: 'pcm', sampleRate: 192000, pcmBitDepth: 24, subscribers: 1 }),
  ]);
  assert.equal(format?.sampleRate, 192000);
  assert.equal(format?.bitDepth, 24);
});

test('the measured encoder throughput is exposed as bits per second', () => {
  assert.equal(toStreamFormat([stat({ profile: 'mp3', bps: 40000 })])?.bitrate, 320000);
  assert.equal(toStreamFormat([stat({ bps: null })])?.bitrate, 44100 * 2 * 16);
});

test('a profile with no subscribers is still reported when none has any', () => {
  // Between a play command and the device connecting there is a real format worth showing.
  const format = toStreamFormat([stat({ subscribers: 0, sampleRate: 96000 })]);
  assert.equal(format?.sampleRate, 96000);
});
