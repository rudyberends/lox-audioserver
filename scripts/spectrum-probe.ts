/**
 * What the realtime analyzer actually reports, and what it costs.
 *
 * The spectrum is easy to get subtly wrong in a way no error message reveals: bars that can
 * never light up, bands sitting at the wrong frequency, a level that cancels itself on wide
 * stereo. All of it looks like "the music" unless you feed the analyzer something whose answer
 * you already know. This does that — white noise (every band must respond) and pure tones (each
 * must land in the band that contains it) — and then measures the DSP against real time.
 *
 *   npx tsx scripts/spectrum-probe.ts [sampleRate] [bins]
 *
 * To see the same numbers from the live server instead, open the stream on a playing zone:
 *   curl -sN localhost:7090/api/v1/zones/28/analysis?types=spectrum&bins=48
 * `analysis.ready` states the geometry the bins it sends were computed with.
 */
import { SendspinVisualizer, windowSizeFor } from '../src/adapters/outputs/sendspin/sendspinVisualizer';

const SAMPLE_RATE = Number(process.argv[2] ?? 44100);
const BINS = Number(process.argv[3] ?? 48);
const F_MIN = 40;
const F_MAX = 16000;
const WINDOW = windowSizeFor(SAMPLE_RATE);

const spectrum = { n_disp_bins: BINS, scale: 'log' as const, f_min: F_MIN, f_max: F_MAX };
const bandEdge = (i: number): number => F_MIN * (F_MAX / F_MIN) ** (i / BINS);

function analyzer(
  onSpectrum: (bins: Uint16Array) => void,
  channels: number,
  bitDepth: number,
): SendspinVisualizer {
  return new SendspinVisualizer({
    sampleRate: SAMPLE_RATE,
    channels,
    bitDepth,
    rateMax: 30,
    emitLoudness: false,
    emitFpeak: false,
    emitPeak: false,
    emitPitch: false,
    spectrum,
    onSpectrum,
  });
}

/** 24-bit interleaved white noise: deterministic, so a bad run is reproducible. */
function noise24(frames: number, channels: number): Buffer {
  const buf = Buffer.alloc(frames * 3 * channels);
  let seed = 7;
  for (let i = 0; i < frames * channels; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    buf.writeIntLE(Math.round(((seed / 0x7fffffff) * 2 - 1) * 0.3 * 8388607), i * 3, 3);
  }
  return buf;
}

function tone16(hz: number, frames: number): Buffer {
  const buf = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    buf.writeInt16LE(
      Math.round(0.6 * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * 32767),
      i * 2,
    );
  }
  return buf;
}

console.log(`${SAMPLE_RATE} Hz, ${BINS} log bins over ${F_MIN}-${F_MAX} Hz`);
console.log(
  `FFT: ${WINDOW} points = ${(SAMPLE_RATE / WINDOW).toFixed(1)} Hz per bin, ` +
    `${((WINDOW / SAMPLE_RATE) * 1000).toFixed(0)} ms window`,
);
console.log(
  `narrowest display band: ${(bandEdge(1) - bandEdge(0)).toFixed(1)} Hz ` +
    `(${F_MIN}-${bandEdge(1).toFixed(1)} Hz) — narrower than one FFT bin, so it is interpolated`,
);

/*
 * 1. Coverage. Noise excites every band, so a bin still at zero has no FFT bin behind it.
 *
 * Held over several windows: any one realization of noise has spectral nulls, and a display band
 * narrow enough to hold a single FFT bin can land in one. A bin that is zero across all of them
 * is unreachable by construction rather than merely unlucky.
 */
const held = new Uint16Array(BINS);
const coverage = analyzer((b) => {
  for (let i = 0; i < BINS; i += 1) if (b[i]! > held[i]!) held[i] = b[i]!;
}, 2, 24);
for (let w = 0; w < 8; w += 1) coverage.push(noise24(WINDOW, 2), w * 200_000);
const noiseBins: Uint16Array = held;
const dead = [...noiseBins].map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
console.log(
  `\nwhite noise -> ${dead.length === 0 ? 'every bin responds' : `DEAD BINS: ${dead.join(',')}`}`,
);
console.log(`  ${[...noiseBins].map((v) => Math.round((v / 65535) * 100)).join(' ')}`);

// 2. Placement. A tone must peak in the band whose edges contain it.
console.log('\ntone placement:');
for (const hz of [50, 110, 440, 1000, 4000, 12000]) {
  if (hz >= SAMPLE_RATE / 2) continue;
  let bins: Uint16Array | null = null;
  analyzer((b) => {
    bins = Uint16Array.from(b);
  }, 1, 16).push(tone16(hz, WINDOW), 0);
  let argmax = 0;
  for (let i = 1; i < BINS; i += 1) if (bins![i]! > bins![argmax]!) argmax = i;
  // One band either way is expected: a Hann window spreads a tone into its neighbours.
  const ok = hz >= bandEdge(argmax - 1) && hz <= bandEdge(argmax + 2);
  console.log(
    `  ${String(hz).padStart(5)} Hz -> bin ${String(argmax).padStart(2)} ` +
      `(${bandEdge(argmax).toFixed(0)}-${bandEdge(argmax + 1).toFixed(0)} Hz) ` +
      `${ok ? 'ok' : 'OFF BY MORE THAN A BAND'}`,
  );
}

// 3. Cost, against real time. One analyzer exists per subscriber per zone, so this is the number
// that decides whether a zone can afford a Sendspin client and a browser watching at once.
const FRAME = 1024;
const FRAMES = 3000;
const buf = noise24(FRAME, 2);
for (const [label, everything] of [
  ['spectrum + loudness', false],
  ['spectrum + loudness + f_peak + peak + pitch', true],
] as const) {
  const dsp = new SendspinVisualizer({
    sampleRate: SAMPLE_RATE,
    channels: 2,
    bitDepth: 24,
    rateMax: 30,
    emitLoudness: true,
    emitFpeak: everything,
    emitPeak: everything,
    emitPitch: everything,
    spectrum,
    onLoudness: () => {},
    onSpectrum: () => {},
    onFpeak: () => {},
    onPeak: () => {},
    onPitch: () => {},
  });
  const started = process.hrtime.bigint();
  for (let i = 0; i < FRAMES; i += 1) dsp.push(buf, Math.round((i * FRAME * 1e6) / SAMPLE_RATE));
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const audioSec = (FRAMES * FRAME) / SAMPLE_RATE;
  console.log(
    `\n${label}: ${ms.toFixed(0)} ms of CPU for ${audioSec.toFixed(0)} s of audio ` +
      `= ${((ms / 1000 / audioSec) * 100).toFixed(2)}% of one core`,
  );
}
