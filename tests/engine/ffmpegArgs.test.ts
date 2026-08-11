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

test('getLogLevel is quiet unless the source format is unknown', () => {
  // `info` is how the input banner gets printed, which is the only way to learn the native format of a
  // stream whose provider did not declare one — `AudioSession.observeSourceFormat` reads it. A source we
  // already know stays quiet, and an explicit request from the caller always wins.
  assert.equal(
    new FfmpegArgBuilder({ kind: 'file', path: '/tmp/x' }, 'mp3', defaultOutput, false, undefined, {
      sampleRate: 44100,
      channels: 2,
      bitDepth: 16,
      lossless: true,
    }).getLogLevel(),
    'error',
    'a probed source needs no banner',
  );
  assert.equal(
    makeBuilder({ kind: 'file', path: '/tmp/x' }).getLogLevel(),
    'info',
    'an unknown source is worth one banner',
  );
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

test('describeProcessing reports an untouched chain as untouched', () => {
  const builder = new FfmpegArgBuilder(
    { kind: 'file', path: '/x.flac' },
    'pcm',
    defaultOutput,
    false,
    undefined,
    { sampleRate: 44100, channels: 2, bitDepth: 16, lossless: true, codecName: 'flac' },
  );
  assert.deepEqual(builder.describeProcessing(null), {
    resampled: false,
    resampler: null,
    requantised: false,
    channelsRemapped: false,
    reencoded: false,
    equalizer: null,
    gainDb: null,
    delayMs: null,
    dither: null,
  });
});

test('describeProcessing names every stage that actually runs', () => {
  const builder = new FfmpegArgBuilder(
    { kind: 'url', url: 'https://x/y.m4a', gainDb: -3.5 },
    'aac',
    { ...defaultOutput, sampleRate: 48000, fixedGainDb: 2 },
    false,
    120,
    { sampleRate: 44100, channels: 1, bitDepth: 24, lossless: true, codecName: 'flac' },
  );
  const chain = builder.describeProcessing([0, 3, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(chain.resampled, true, 'a rate mismatch runs the resampler');
  assert.deepEqual(chain.resampler, { name: 'soxr', precision: 28, cutoff: 0.97 });
  assert.equal(chain.requantised, true, 'a 24-bit source into a 16-bit sink is requantised');
  assert.equal(chain.channelsRemapped, true, 'a mono source into a stereo sink is remapped');
  assert.equal(chain.reencoded, true, 'aac re-encodes by definition');
  assert.deepEqual(chain.equalizer, { bands: [0, 3, 0, 0, 0, 0, 0, 0, 0, 0] });
  assert.deepEqual(chain.gainDb, { source: -3.5, output: 2 });
  assert.equal(chain.delayMs, 120);
});

/** The filter chain of a single-stage session, as one string. */
function filterChain(builder: FfmpegArgBuilder, bands: number[] | null): string {
  const args = builder.buildOutputArgs(bands);
  const idx = args.indexOf('-af');
  return idx === -1 ? '' : args[idx + 1] ?? '';
}

const EQ_BANDS = [0, 3, 0, 0, 0, -2, 0, 0, 0, 0];
const LOSSLESS_16_44 = {
  sampleRate: 44100, channels: 2, bitDepth: 16, lossless: true, codecName: 'flac',
};

test('DSP runs in float, not in the source’s integer format', () => {
  // A 16-bit source at the output rate made ffmpeg negotiate s16p for the whole biquad cascade:
  // measured 17 dB above the 16-bit noise floor versus the same EQ in float, for no CPU saving worth
  // having. `aformat` must therefore come first, before any filter that could pick the format.
  const chain = filterChain(
    makeBuilderWithNative('pcm', LOSSLESS_16_44),
    EQ_BANDS,
  );
  assert.ok(chain.startsWith('aformat=sample_fmts=fltp,'), chain);
});

test('the resampler is last and pins its output rate', () => {
  // Without osr this filter may keep the input rate — the EQ downstream accepts any — and ffmpeg
  // auto-inserts its own aresample with default options to reach the output. Switching on one EQ band
  // then silently replaced soxr at precision 28 with stock swr.
  const chain = filterChain(
    new FfmpegArgBuilder({ kind: 'file', path: '/x.flac' }, 'pcm', defaultOutput, false, undefined, {
      sampleRate: 96000, channels: 2, bitDepth: 24, lossless: true,
    }),
    EQ_BANDS,
  );
  const stages = chain.split(',');
  const last = stages[stages.length - 1] ?? '';
  assert.ok(last.startsWith('aresample=resampler=soxr'), last);
  assert.ok(last.includes('osr=44100'), last);
  assert.equal(
    stages.filter((stage) => stage.startsWith('aresample')).length,
    1,
    'one conversion, at the end',
  );
});

test('a 16-bit output is dithered; a lossy output is left in float', () => {
  const toPcm16 = filterChain(makeBuilderWithNative('pcm', LOSSLESS_16_44), EQ_BANDS);
  assert.ok(toPcm16.includes('osf=s16'), toPcm16);
  assert.ok(toPcm16.includes('dither_method=triangular_hp'), toPcm16);

  // mp3/aac/opus encoders take float natively, so pinning an integer format would only add a round trip.
  const toMp3 = filterChain(makeBuilderWithNative('mp3', LOSSLESS_16_44), EQ_BANDS);
  assert.ok(!toMp3.includes('osf='), toMp3);
  assert.ok(!toMp3.includes('dither_method'), toMp3);
});

test('a 24-bit output carries no dither and describes itself that way', () => {
  const at24 = { ...defaultOutput, pcmBitDepth: 24 as const };
  const builder = new FfmpegArgBuilder({ kind: 'file', path: '/x.flac' }, 'pcm', at24, false, undefined, {
    sampleRate: 96000, channels: 2, bitDepth: 24, lossless: true,
  });
  const chain = filterChain(builder, null);
  assert.ok(chain.includes('osf=s32'), chain);
  assert.ok(!chain.includes('dither_method'), chain);
  assert.equal(builder.describeProcessing(null).dither, null);
});

test('a bit-perfect session has no filter chain at all', () => {
  const builder = makeBuilderWithNative('pcm', LOSSLESS_16_44);
  assert.equal(filterChain(builder, null), '');
  assert.equal(builder.describeProcessing(null).resampled, false);
});

test('describeProcessing cannot claim a resampler the chain does not run', () => {
  // The description is rendered from the same stage list as the args, so the two agree by construction.
  const builder = makeBuilderWithNative('pcm', LOSSLESS_16_44);
  for (const bands of [null, EQ_BANDS]) {
    const chain = filterChain(builder, bands);
    const described = builder.describeProcessing(bands);
    assert.equal(chain.includes('aresample'), described.resampled);
    assert.equal(chain.includes('dither_method'), described.dither !== null);
    assert.equal(chain.includes('equalizer='), described.equalizer !== null);
  }
});

test('the two-stage encoder applies the EQ and the source gain', () => {
  // Both used to be dropped silently: enabling crossfade switched the zone's equalizer and Spotify's
  // loudness normalisation off while the API kept reporting them.
  const builder = new FfmpegArgBuilder(
    { kind: 'url', url: 'https://x/y.m4a', gainDb: -3.5 },
    'flac', defaultOutput, false, undefined,
  );
  const args = builder.buildPcmEncoderArgs(EQ_BANDS);
  const idx = args.indexOf('-af');
  assert.notEqual(idx, -1, 'the encoder stage carries the DSP chain');
  const chain = args[idx + 1] ?? '';
  assert.ok(chain.includes('equalizer=f=63'), chain);
  assert.ok(chain.includes('volume=-3.50dB'), chain);
  assert.ok(chain.startsWith('aformat=sample_fmts=fltp,'), chain);
});

test('the two-stage decoder resamples with soxr into the bus', () => {
  // The decoder is the stage that changes rate, so soxr and the dither belong there rather than in the
  // encoder, which only ever sees bus-rate PCM.
  const args = new FfmpegArgBuilder(
    { kind: 'file', path: '/x.flac' }, 'flac', defaultOutput, false, undefined,
  ).buildPcmDecoderArgs();
  const chain = args[args.indexOf('-af') + 1] ?? '';
  assert.ok(chain.includes('resampler=soxr'), chain);
  assert.ok(chain.includes('osr=44100'), chain);
  assert.ok(chain.includes('dither_method=triangular_hp'), chain);
});

function makeBuilderWithNative(
  profile: 'mp3' | 'flac' | 'pcm' | 'aac' | 'opus',
  native: { sampleRate: number; channels: number; bitDepth: number | null; lossless: boolean; codecName?: string },
): FfmpegArgBuilder {
  return new FfmpegArgBuilder(
    { kind: 'file', path: '/x.flac' }, profile, defaultOutput, false, undefined, native,
  );
}

