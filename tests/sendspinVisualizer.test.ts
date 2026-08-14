import assert from 'node:assert/strict';
import { Jimp } from 'jimp';
import { test } from './testHarness';
import { SendspinVisualizer, windowSizeFor } from '../src/adapters/outputs/sendspin/sendspinVisualizer';
import { derivePalette, type Rgb } from '../src/application/artwork/artworkPalette';

const SAMPLE_RATE = 48_000;
const WINDOW = 2048;

/** Build an interleaved mono 16-bit PCM buffer holding a pure sine. */
function sineMono16(freqHz: number, amp: number, samples: number): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const s = amp * Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2);
  }
  return buf;
}

function baseOpts(extra: Partial<ConstructorParameters<typeof SendspinVisualizer>[0]> = {}) {
  return {
    sampleRate: SAMPLE_RATE,
    channels: 1,
    bitDepth: 16,
    rateMax: 30,
    emitLoudness: false,
    emitFpeak: false,
    emitPeak: false,
    emitPitch: false,
    ...extra,
  };
}

// --- loudness ---------------------------------------------------------------

test('visualizer: loudness rises with amplitude and is zero on silence', () => {
  const seen: number[] = [];
  const make = (amp: number): number => {
    seen.length = 0;
    const dsp = new SendspinVisualizer(baseOpts({ emitLoudness: true, onLoudness: (v) => seen.push(v) }));
    dsp.push(sineMono16(1000, amp, WINDOW), 0);
    assert.equal(seen.length, 1, 'one full window emits exactly once');
    return seen[0]!;
  };

  const silence = (): number => {
    seen.length = 0;
    const dsp = new SendspinVisualizer(baseOpts({ emitLoudness: true, onLoudness: (v) => seen.push(v) }));
    dsp.push(Buffer.alloc(WINDOW * 2), 0);
    return seen[0]!;
  };

  assert.equal(silence(), 0, 'silence maps to 0');
  const quiet = make(0.1);
  const loud = make(0.7);
  assert.ok(loud > quiet, `louder signal must read higher (${loud} > ${quiet})`);
  assert.ok(quiet > 0, 'audible signal must be non-zero');
});

test('visualizer: the wire value is a dB position, not an amplitude', () => {
  /*
   * The encoding consumers get wrong, in both directions. The u16 is where the level sits in the
   * [-60, 0] dBFS window, linear in dB — not a linear amplitude. A client that takes 20·log10 of it
   * reads a true -20 dBFS as -3.5 and paints it at 94% of the height, so everything looks clipped
   * and a solo voice draws the same flat wall as a full mix. (That is exactly what the player did.)
   *
   * Pinned by measuring known levels: halving the amplitude is -6 dB, which must move the value by
   * a tenth of full scale (6 of the 60 dB window) — a linear-amplitude encoding would halve it.
   */
  const levelOf = (amp: number): number => {
    let seen = -1;
    const dsp = new SendspinVisualizer(baseOpts({ emitLoudness: true, onLoudness: (v) => { seen = v; } }));
    dsp.push(sineMono16(1000, amp, WINDOW), 0);
    return seen;
  };
  const toDb = (value: number): number => -60 + (value / 65535) * 60;

  // A full-scale sine is -3.01 dBFS RMS. Nothing may ever read above it.
  const full = toDb(levelOf(1));
  assert.ok(Math.abs(full - -3.01) < 0.6, `full-scale sine reads ${full.toFixed(2)} dBFS (expect ~-3)`);

  const half = toDb(levelOf(0.5));
  assert.ok(Math.abs(half - (full - 6.02)) < 0.3, `halving amplitude is -6 dB (${full.toFixed(2)} -> ${half.toFixed(2)})`);

  // And the encoding is linear in dB: equal dB steps are equal steps in the value.
  const steps = [1, 0.5, 0.25, 0.125].map(levelOf);
  const deltas = steps.slice(1).map((v, i) => steps[i]! - v);
  for (const delta of deltas) {
    assert.ok(
      Math.abs(delta - (6.02 / 60) * 65535) < 400,
      `each -6 dB step moves ~${((6.02 / 60) * 65535).toFixed(0)} counts, got ${delta.toFixed(0)}`,
    );
  }
});

// --- f_peak -----------------------------------------------------------------

test('visualizer: f_peak locates the dominant tone', () => {
  for (const freq of [440, 1000, 4000]) {
    let peakHz = -1;
    const dsp = new SendspinVisualizer(baseOpts({ emitFpeak: true, onFpeak: (hz) => { peakHz = hz; } }));
    dsp.push(sineMono16(freq, 0.6, WINDOW), 0);
    assert.ok(Math.abs(peakHz - freq) < 25, `f_peak ${peakHz}Hz should be within a bin of ${freq}Hz`);
  }
});

// --- spectrum ---------------------------------------------------------------

test('visualizer: spectrum concentrates energy in the tone band', () => {
  const nBins = 32;
  const fMin = 20;
  const fMax = 20_000;
  let bins: Uint16Array | null = null;
  const dsp = new SendspinVisualizer(baseOpts({
    spectrum: { n_disp_bins: nBins, scale: 'lin', f_min: fMin, f_max: fMax },
    onSpectrum: (b) => { bins = Uint16Array.from(b); },
  }));
  dsp.push(sineMono16(1000, 0.6, WINDOW), 0);
  assert.ok(bins, 'spectrum frame emitted');
  const out: Uint16Array = bins;

  let argmax = 0;
  for (let i = 1; i < out.length; i += 1) if (out[i]! > out[argmax]!) argmax = i;
  assert.ok(out[argmax]! > 0, 'peak bin is non-zero');
  // Linear bin centers across [fMin,fMax]; the winning bin must straddle ~1000 Hz.
  const center = fMin + ((argmax + 0.5) / nBins) * (fMax - fMin);
  assert.ok(Math.abs(center - 1000) < (fMax - fMin) / nBins, `peak bin center ${center}Hz near 1000Hz`);
});

test('visualizer: every display bin can carry a value, however narrow its band', () => {
  /*
   * The regression this locks down: the FFT->display mapping left low display bins empty
   * because a log scale makes them narrower than the FFT's 23 Hz resolution. Measured on a
   * playing zone, 5 of 48 bars could never light up — at 40 Hz the first band is 5.3 Hz wide.
   *
   * White noise excites every band, so any bin still reading zero is unreachable by
   * construction rather than merely silent — held over several windows, because one
   * realization of noise has nulls a single-bin band can fall into.
   */
  const nBins = 48;
  const held = new Uint16Array(nBins);
  const dsp = new SendspinVisualizer(baseOpts({
    spectrum: { n_disp_bins: nBins, scale: 'log', f_min: 40, f_max: 16_000 },
    onSpectrum: (b) => {
      for (let i = 0; i < nBins; i += 1) if (b[i]! > held[i]!) held[i] = b[i]!;
    },
  }));
  // Deterministic pseudo-noise: a fixed LCG, so a failure is reproducible.
  let seed = 12345;
  for (let w = 0; w < 8; w += 1) {
    const noise = Buffer.alloc(WINDOW * 2);
    for (let i = 0; i < WINDOW; i += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      noise.writeInt16LE(Math.round(((seed / 0x7fffffff) * 2 - 1) * 12000), i * 2);
    }
    dsp.push(noise, w * 200_000);
  }
  const dead = [...held].map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(dead, [], 'no display bin is structurally unreachable');
});

test('visualizer: a tone lands in the display bin whose band contains it', () => {
  // Bands are log-spaced, so the check is the band's own edges rather than a linear centre.
  const nBins = 48;
  const fMin = 40;
  const fMax = 16_000;
  for (const freq of [110, 440, 2000, 8000]) {
    let bins: Uint16Array | null = null;
    const dsp = new SendspinVisualizer(baseOpts({
      spectrum: { n_disp_bins: nBins, scale: 'log', f_min: fMin, f_max: fMax },
      onSpectrum: (b) => { bins = Uint16Array.from(b); },
    }));
    dsp.push(sineMono16(freq, 0.6, WINDOW), 0);
    const out = bins!;
    let argmax = 0;
    for (let i = 1; i < out.length; i += 1) if (out[i]! > out[argmax]!) argmax = i;
    const edge = (i: number): number => fMin * (fMax / fMin) ** (i / nBins);
    // Within one band either way: a Hann window spreads a tone over its neighbours.
    assert.ok(
      freq >= edge(argmax - 1) && freq <= edge(argmax + 2),
      `${freq}Hz peaked at bin ${argmax} (${edge(argmax).toFixed(0)}-${edge(argmax + 1).toFixed(0)}Hz)`,
    );
  }
});

test('visualizer: frequency resolution holds at high sample rates', () => {
  /*
   * The window is a duration, not a sample count. A fixed 2048 points resolves 21 Hz at 44.1 kHz
   * but only 94 Hz at 192 kHz — the whole bass register inside one FFT bin, on exactly the files
   * this server exists to pass through untouched. Scaling the window with the rate keeps the
   * resolution (and so the look of the display) the same everywhere.
   */
  for (const rate of [44_100, 48_000, 96_000, 192_000]) {
    const window = windowSizeFor(rate);
    assert.ok(Number.isInteger(Math.log2(window)), `${window} is a power of two (radix-2 FFT)`);
    const hzPerBin = rate / window;
    assert.ok(hzPerBin >= 18 && hzPerBin <= 26, `${rate} Hz resolves ${hzPerBin.toFixed(1)} Hz per bin`);
  }

  // And it holds in practice: a bass tone at 192 kHz still lands in its own band.
  const nBins = 48;
  const fMin = 40;
  const fMax = 16_000;
  const rate = 192_000;
  const window = windowSizeFor(rate);
  let bins: Uint16Array | null = null;
  const dsp = new SendspinVisualizer({
    ...baseOpts({
      spectrum: { n_disp_bins: nBins, scale: 'log', f_min: fMin, f_max: fMax },
      onSpectrum: (b) => { bins = Uint16Array.from(b); },
    }),
    sampleRate: rate,
  });
  const tone = Buffer.alloc(window * 2);
  for (let i = 0; i < window; i += 1) {
    tone.writeInt16LE(Math.round(0.6 * Math.sin((2 * Math.PI * 110 * i) / rate) * 32767), i * 2);
  }
  dsp.push(tone, 0);
  const out = bins!;
  let argmax = 0;
  for (let i = 1; i < out.length; i += 1) if (out[i]! > out[argmax]!) argmax = i;
  const edge = (i: number): number => fMin * (fMax / fMin) ** (i / nBins);
  assert.ok(
    110 >= edge(argmax - 1) && 110 <= edge(argmax + 2),
    `110Hz at ${rate}Hz peaked at bin ${argmax} (${edge(argmax).toFixed(0)}-${edge(argmax + 1).toFixed(0)}Hz)`,
  );
});

test('visualizer: level survives channels in opposite phase', () => {
  /*
   * L and R inverted is what a hard-panned or deliberately wide stereo mix looks like at
   * some frequencies. The mid mix cancels it to nothing; the level must not, or the meter
   * reads silence over music.
   */
  const samples = WINDOW;
  const buf = Buffer.alloc(samples * 2 * 2);
  for (let i = 0; i < samples; i += 1) {
    const s = Math.round(0.5 * Math.sin((2 * Math.PI * 1000 * i) / SAMPLE_RATE) * 32767);
    buf.writeInt16LE(s, i * 4);
    buf.writeInt16LE(-s, i * 4 + 2);
  }
  let loudness = -1;
  const dsp = new SendspinVisualizer(baseOpts({
    channels: 2,
    emitLoudness: true,
    onLoudness: (v) => { loudness = v; },
  }));
  dsp.push(buf, 0);
  assert.ok(loudness > 0, `anti-phase stereo must still read a level (got ${loudness})`);
});

test('visualizer: bar fall time follows wall-clock, not the frame rate', () => {
  /*
   * The decay used to be a fixed factor per emitted frame, so the same music held its bars
   * three times as long at 10 fps as at 30. Compare the same elapsed time at two rates.
   */
  const decayedAt = (rateMax: number): number => {
    const frames: Uint16Array[] = [];
    const dsp = new SendspinVisualizer(baseOpts({
      rateMax,
      spectrum: { n_disp_bins: 16, scale: 'log', f_min: 40, f_max: 16_000 },
      onSpectrum: (b) => frames.push(Uint16Array.from(b)),
    }));
    const step = Math.floor(1_000_000 / rateMax);
    dsp.push(sineMono16(1000, 0.6, WINDOW), 0);
    // 200 ms of silence, delivered at that rate.
    for (let t = step; t <= 200_000; t += step) dsp.push(Buffer.alloc(WINDOW * 2), t);
    const last = frames[frames.length - 1]!;
    return Math.max(...last);
  };
  const slow = decayedAt(10);
  const fast = decayedAt(30);
  assert.ok(
    Math.abs(slow - fast) < 0.02 * 65535,
    `same elapsed time must decay alike (10fps ${slow} vs 30fps ${fast})`,
  );
});

// --- pitch ------------------------------------------------------------------

test('visualizer: pitch tracks a tone to the right MIDI note', () => {
  // 220 Hz == A3 == MIDI 57; the wire value is MIDI in 8.8 fixed point.
  let midiQ88 = -1;
  let confidence = -1;
  const dsp = new SendspinVisualizer(baseOpts({ emitPitch: true, onPitch: (m, c) => { midiQ88 = m; confidence = c; } }));
  dsp.push(sineMono16(220, 0.6, WINDOW), 0);
  assert.ok(midiQ88 > 0, 'pitch emitted for a voiced tone');
  const midi = midiQ88 / 256;
  assert.ok(Math.abs(midi - 57) < 1, `detected MIDI ${midi.toFixed(2)} within a semitone of 57 (A3)`);
  assert.ok(confidence > 0, 'confidence reported');
});

test('visualizer: pitch is gated out on silence', () => {
  let emitted = false;
  const dsp = new SendspinVisualizer(baseOpts({ emitPitch: true, onPitch: () => { emitted = true; } }));
  dsp.push(Buffer.alloc(WINDOW * 2), 0);
  assert.equal(emitted, false, 'unvoiced/silent input emits no pitch');
});

// --- peak (onset) -----------------------------------------------------------

test('visualizer: peak fires on a sudden energy jump, not on steady level', () => {
  const peaks: number[] = [];
  const dsp = new SendspinVisualizer(baseOpts({ rateMax: 30, emitPeak: true, onPeak: (s) => peaks.push(s) }));
  const interval = Math.floor(1_000_000 / 30);
  // Two steady-quiet windows establish the running mean (no onset)...
  dsp.push(sineMono16(1000, 0.1, WINDOW), 0);
  dsp.push(sineMono16(1000, 0.1, WINDOW), interval);
  assert.equal(peaks.length, 0, 'steady level produces no onset');
  // ...then a loud burst (>=4x amplitude => >=16x energy) must trip the detector.
  dsp.push(sineMono16(1000, 0.6, WINDOW), interval * 2);
  assert.ok(peaks.length >= 1, 'energy jump produces an onset');
  assert.ok(peaks[0]! > 0, 'onset strength is non-zero');
});

// --- pacing -----------------------------------------------------------------

test('visualizer: emits are paced to rate_max', () => {
  let count = 0;
  const dsp = new SendspinVisualizer(baseOpts({ rateMax: 30, emitLoudness: true, onLoudness: () => { count += 1; } }));
  const interval = Math.floor(1_000_000 / 30);
  dsp.push(sineMono16(1000, 0.3, WINDOW), 0);
  // Too soon: below the emit interval, must be suppressed.
  dsp.push(sineMono16(1000, 0.3, WINDOW), interval - 1);
  assert.equal(count, 1, 'sub-interval push is rate-limited');
  // At/after the interval: allowed.
  dsp.push(sineMono16(1000, 0.3, WINDOW), interval);
  assert.equal(count, 2, 'push at the interval boundary emits');
});

test('visualizer: no emit until a full window is buffered', () => {
  let count = 0;
  const dsp = new SendspinVisualizer(baseOpts({ emitLoudness: true, onLoudness: () => { count += 1; } }));
  dsp.push(sineMono16(1000, 0.3, WINDOW - 1), 0);
  assert.equal(count, 0, 'a partial window emits nothing');
  dsp.push(sineMono16(1000, 0.3, 1), 1_000_000);
  assert.equal(count, 1, 'completing the window emits once');
});

// --- palette (color@v1) -----------------------------------------------------

function channelLum(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channelLum(r) + 0.7152 * channelLum(g) + 0.0722 * channelLum(b);
}
function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// A constructed Jimp and the one Jimp.read() resolves to differ in their format
// generics; every caller here wants the read() shape, so convert once.
type JimpImage = Awaited<ReturnType<typeof Jimp.read>>;

async function solid(colorRgbaHex: number): Promise<JimpImage> {
  return new Jimp({ width: 16, height: 16, color: colorRgbaHex }) as unknown as JimpImage;
}

test('palette: on/background pairs satisfy the WCAG 4.5:1 contrast invariant', async () => {
  // Saturated red, near-black, near-white, and mid-grey artwork.
  for (const hex of [0xff0000ff, 0x101010ff, 0xf0f0f0ff, 0x808080ff]) {
    const pal = derivePalette(await solid(hex));
    assert.ok(
      contrast(pal.on_dark, pal.background_dark) >= 4.5,
      `on_dark vs background_dark >= 4.5:1 for #${hex.toString(16)}`,
    );
    assert.ok(
      contrast(pal.on_light, pal.background_light) >= 4.5,
      `on_light vs background_light >= 4.5:1 for #${hex.toString(16)}`,
    );
    for (const c of [pal.primary, pal.accent, pal.background_dark, pal.background_light, pal.on_dark, pal.on_light]) {
      for (const v of c) assert.ok(Number.isInteger(v) && v >= 0 && v <= 255, 'palette channels are valid u8');
    }
  }
});

test('palette: a vivid image yields a saturated primary; greyscale falls back to grey', async () => {
  const red = derivePalette(await solid(0xff0000ff));
  assert.ok(red.primary[0]! > red.primary[1]! && red.primary[0]! > red.primary[2]!, 'red artwork -> red-dominant primary');

  const grey = derivePalette(await solid(0x808080ff));
  const [r, g, b] = grey.primary;
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  assert.ok(spread < 16, `greyscale artwork -> near-neutral primary (spread ${spread})`);
});
