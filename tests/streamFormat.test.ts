import assert from 'node:assert/strict';
import { test } from './testHarness';
import { toApiAudioFormat, toStreamFormat } from '../src/adapters/http/api/streamFormat';
import type { EngineSessionStats } from '../src/ports/EnginePort';

// Sendspin already shows its client the codec, rate, depth and channel count, and the admin
// UI has had it in `tech` all along — but a player on the public API could not tell a listener
// what they were hearing.

const stat = (over: Partial<EngineSessionStats>): EngineSessionStats =>
  ({
    profile: 'pcm',
    sampleRate: 44100,
    channels: 2,
    pcmBitDepth: 16,
    bps: null,
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
  const format = toStreamFormat([stat({ sampleRate: 192000, pcmBitDepth: 24 })]);
  assert.deepEqual(format, {
    codec: 'pcm',
    sampleRate: 192000,
    bitDepth: 24,
    channels: 2,
    bitrate: null,
  });
  // Buffer sizes, restart counts and subscriber drops are engine health and stay out.
  assert.deepEqual(Object.keys(format!).sort(), [
    'bitDepth',
    'bitrate',
    'channels',
    'codec',
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
    source: {
      codec: 'flac',
      sampleRate: 96000,
      channels: 2,
      bitDepth: 24,
      bitrate: null,
    },
    output: {
      codec: 'pcm',
      sampleRate: 44100,
      channels: 2,
      bitDepth: 24,
      bitrate: null,
    },
  });
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

test('an encoder bitrate is reported when there is one', () => {
  assert.equal(toStreamFormat([stat({ profile: 'mp3', bps: 320000 })])?.bitrate, 320000);
  // PCM is a constant rate the encoder does not report; nothing is derived.
  assert.equal(toStreamFormat([stat({ bps: null })])?.bitrate, null);
});

test('a profile with no subscribers is still reported when none has any', () => {
  // Between a play command and the device connecting there is a real format worth showing.
  const format = toStreamFormat([stat({ subscribers: 0, sampleRate: 96000 })]);
  assert.equal(format?.sampleRate, 96000);
});
