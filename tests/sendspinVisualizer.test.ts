import assert from 'node:assert/strict';
import { Jimp } from 'jimp';
import { test } from './testHarness';
import { SendspinVisualizer } from '../src/adapters/outputs/sendspin/sendspinVisualizer';
import { derivePalette, type Rgb } from '../src/adapters/outputs/sendspin/artworkPalette';

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
  const out = bins!;

  let argmax = 0;
  for (let i = 1; i < out.length; i += 1) if (out[i]! > out[argmax]!) argmax = i;
  assert.ok(out[argmax]! > 0, 'peak bin is non-zero');
  // Linear bin centers across [fMin,fMax]; the winning bin must straddle ~1000 Hz.
  const center = fMin + ((argmax + 0.5) / nBins) * (fMax - fMin);
  assert.ok(Math.abs(center - 1000) < (fMax - fMin) / nBins, `peak bin center ${center}Hz near 1000Hz`);
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

async function solid(colorRgbaHex: number): Promise<Awaited<ReturnType<typeof Jimp.read>>> {
  return new Jimp({ width: 16, height: 16, color: colorRgbaHex });
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
