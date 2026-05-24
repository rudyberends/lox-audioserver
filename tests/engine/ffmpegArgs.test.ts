import assert from 'node:assert/strict';
import { test } from '../testHarness';
import { FfmpegArgBuilder } from '../../src/engine/ffmpegArgs';
import type { PlaybackSource } from '../../src/engine/audioSession';
import type { AudioOutputSettings } from '../../src/engine/audioFormat';

const defaultOutput: AudioOutputSettings = {
  sampleRate: 44100,
  channels: 2,
  pcmBitDepth: 16,
  mp3Bitrate: '256k',
  prebufferBytes: 262144,
  httpProfile: 'default',
  httpFallbackSeconds: 12 * 3600,
  fixedGainDb: 0,
  httpIcyEnabled: false,
  httpIcyInterval: 16384,
  httpIcyName: 'test',
};

function makeBuilder(source: PlaybackSource, profile: 'mp3' | 'flac' | 'pcm' | 'aac' | 'opus' = 'mp3'): FfmpegArgBuilder {
  return new FfmpegArgBuilder(source, profile, defaultOutput, false, undefined);
}

test('buildInputArgs(file) includes -re by default and -i path', () => {
  const args = makeBuilder({ kind: 'file', path: '/tmp/x.mp3' }).buildInputArgs();
  assert.ok(args.includes('-re'));
  assert.ok(args.includes('-i'));
  assert.ok(args.includes('/tmp/x.mp3'));
});

test('buildInputArgs(file) omits -re when realTime=false', () => {
  const args = makeBuilder({ kind: 'file', path: '/tmp/x.mp3', realTime: false }).buildInputArgs();
  assert.ok(!args.includes('-re'));
});

test('buildInputArgs(url) sets reconnect flags and -i url', () => {
  const args = makeBuilder({ kind: 'url', url: 'http://x/y.mp3' }).buildInputArgs();
  assert.ok(args.includes('-reconnect'));
  assert.ok(args.includes('-reconnect_streamed'));
  assert.ok(args.includes('http://x/y.mp3'));
});

test('buildInputArgs(url, flac, realTime=false) still forces -re', () => {
  const builder = new FfmpegArgBuilder(
    { kind: 'url', url: 'http://x/y.flac', realTime: false },
    'flac', defaultOutput, false, undefined,
  );
  assert.ok(builder.buildInputArgs().includes('-re'));
});

test('buildInputArgs(pipe) emits format/rate/channels and pipe:0', () => {
  const args = makeBuilder({
    kind: 'pipe', path: '/tmp/pipe', format: 's24le', sampleRate: 48000, channels: 2,
  }).buildInputArgs();
  assert.ok(args.includes('-f') && args.includes('s24le'));
  assert.ok(args.includes('-ar') && args.includes('48000'));
  assert.ok(args.includes('-i') && args.includes('/tmp/pipe'));
});

test('buildOutputArgs(mp3) ends with -f mp3', () => {
  const args = makeBuilder({ kind: 'file', path: '/tmp/x.mp3' }).buildOutputArgs(null);
  const idx = args.lastIndexOf('-f');
  assert.equal(args[idx + 1], 'mp3');
});

test('buildOutputArgs(flac) ends with -f flac and includes compression_level', () => {
  const args = makeBuilder({ kind: 'file', path: '/tmp/x.mp3' }, 'flac').buildOutputArgs(null);
  assert.ok(args.includes('flac'));
  assert.ok(args.includes('-compression_level'));
});

test('getLogLevel defaults to error; respects source.logLevel for url', () => {
  assert.equal(makeBuilder({ kind: 'file', path: '/tmp/x' }).getLogLevel(), 'error');
  assert.equal(
    makeBuilder({ kind: 'url', url: 'http://x', logLevel: 'verbose' }).getLogLevel(),
    'verbose',
  );
});

test('buildPcmDecoderArgs(file) returns valid two-stage decoder args', () => {
  const args = makeBuilder({ kind: 'file', path: '/tmp/x.flac' }, 'flac').buildPcmDecoderArgs();
  assert.ok(args.includes('-i') && args.includes('/tmp/x.flac'));
  assert.ok(args.includes('pcm_s16le'));
  assert.ok(args.includes('s16le'));
  assert.ok(args.includes('pipe:1'));
});

test('buildPcmEncoderArgs(mp3) starts with -loglevel and outputs to pipe:1', () => {
  const args = makeBuilder({ kind: 'file', path: '/tmp/x' }, 'mp3').buildPcmEncoderArgs();
  assert.ok(args.includes('libmp3lame'));
  assert.ok(args.includes('pipe:1'));
});

test('buildPcmDecoderArgsForSource(file) keeps -re and outputs s16le', () => {
  const args = makeBuilder({ kind: 'file', path: '/tmp/x' }).buildPcmDecoderArgsForSource({
    kind: 'file', path: '/tmp/fade.mp3',
  });
  assert.ok(args.includes('-re'));
  assert.ok(args.includes('/tmp/fade.mp3'));
  assert.ok(args.includes('s16le'));
});
