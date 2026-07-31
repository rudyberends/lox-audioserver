/**
 * Real-time visualizer DSP for the sendspin output (visualizer@v1).
 *
 * Tapped off the PCM frames already flowing to the client (option A: PCM
 * output only — no extra decode), this computes loudness and a display-binned
 * spectrum and emits them paced to the client's rate_max, each tagged with the
 * audio frame's playhead timestamp so the receiver schedules them in sync.
 *
 * Computing visualizer frames is the application's job; node-sendspin only owns
 * the wire format. This is a focused port of the reference server's feature
 * extractor: loudness, spectrum, frequency peak, onset peak and pitch.
 */

import { ANALYSIS_DB_FLOOR, ANALYSIS_FULL_SCALE } from '@/application/audio/audioAnalysisService';

export type SpectrumScale = 'lin' | 'log' | 'mel';

export interface SpectrumConfig {
  n_disp_bins: number;
  scale: SpectrumScale;
  f_min: number;
  f_max: number;
}

export interface VisualizerDspOptions {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  rateMax: number;
  emitLoudness: boolean;
  emitFpeak: boolean;
  emitPeak: boolean;
  emitPitch: boolean;
  spectrum?: SpectrumConfig;
  onLoudness?: (value: number, timestampUs: number) => void;
  onSpectrum?: (bins: Uint16Array, timestampUs: number) => void;
  onFpeak?: (freqHz: number, amplitude: number, timestampUs: number) => void;
  onPeak?: (strength: number, timestampUs: number) => void;
  onPitch?: (midiQ88: number, confidence: number, timestampUs: number) => void;
}

/**
 * The analysis window, as a duration — ~43 ms, which is the reference server's 2048 samples at
 * 48 kHz and the point where a spectrum still feels immediate without flickering.
 *
 * Held constant in *time* rather than in samples, because a fixed sample count means the
 * frequency resolution degrades as the rate rises: 2048 points resolve 21 Hz at 44.1 kHz but
 * only 94 Hz at 192 kHz, which puts the entire bass register inside a single FFT bin. That is
 * exactly backwards for a server whose whole point is following the source up to 192/24. The
 * window is therefore the power of two nearest this duration, so resolution stays ~21-23 Hz and
 * the display behaves identically at every rate — at the cost of an FFT that is 4x the work at
 * 192 kHz, measured at well under 2% of one core (scripts/spectrum-probe.ts).
 */
const WINDOW_MS = 43;
const MIN_WINDOW = 1024;
const MAX_WINDOW = 16384;

/** The power-of-two window closest to WINDOW_MS at this rate; radix-2 needs the power of two. */
export function windowSizeFor(sampleRate: number): number {
  const target = (Math.max(8000, sampleRate) * WINDOW_MS) / 1000;
  const size = 2 ** Math.round(Math.log2(target));
  return Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, size));
}
const DB_FLOOR = ANALYSIS_DB_FLOOR;
const U16_MAX = ANALYSIS_FULL_SCALE;
/**
 * Per-bin fall time, so bars settle between attacks instead of flickering.
 *
 * Expressed as a half-life in wall-clock time rather than a factor per emitted frame:
 * the emit rate is the client's choice (`rate_max`), and a per-frame factor made the
 * bars hang three times as long at 10 fps as at 30 fps for the same music.
 */
const SPECTRUM_HALFLIFE_MS = 45;
// Pitch search range (Hz) → autocorrelation lag bounds. Covers bass to soprano.
const PITCH_F_MIN = 80;
const PITCH_F_MAX = 1000;
// Below this windowed RMS the signal is treated as unvoiced (no pitch emitted).
const PITCH_RMS_GATE = 0.005;
// Minimum normalized autocorrelation peak to accept a pitch.
const PITCH_MIN_CONFIDENCE = 0.5;
// Onset detector: fire when broadband energy exceeds its running mean by this
// factor, no more often than the gap below.
const PEAK_THRESHOLD = 1.6;
const PEAK_MIN_GAP_US = 80_000;
const PEAK_EMA = 0.9;

/** Map a linear amplitude in [0,1] to a u16 over a [-60,0] dB window. */
function ampToU16(amp: number): number {
  if (amp <= 0) return 0;
  const db = 20 * Math.log10(amp);
  const norm = Math.max(0, Math.min(1, (db - DB_FLOOR) / -DB_FLOOR));
  return Math.round(norm * U16_MAX);
}

/** Convert a frequency to a MIDI note in 8.8 fixed-point (clamped to u16). */
function freqToMidiQ88(freq: number): number {
  if (freq <= 0) return 0;
  const midi = 69 + 12 * Math.log2(freq / 440);
  return Math.max(0, Math.min(U16_MAX, Math.round(midi * 256)));
}

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1);
}

/** Hz -> position in the display scale's own domain. */
function hzToScale(scale: SpectrumScale, hz: number): number {
  if (scale === 'mel') return hzToMel(hz);
  if (scale === 'log') return Math.log(hz);
  return hz;
}

/** The inverse, used to place each display bin's *edges* back on the frequency axis. */
function scaleToHz(scale: SpectrumScale, position: number): number {
  if (scale === 'mel') return melToHz(position);
  if (scale === 'log') return Math.exp(position);
  return position;
}

/** In-place iterative radix-2 Cooley-Tukey FFT (indices are always in-bounds). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wpr = Math.cos(ang);
    const wpi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let k = 0; k < half; k += 1) {
        const a = i + k;
        const b = a + half;
        const ar = re[a]!;
        const ai = im[a]!;
        const tr = re[b]! * wr - im[b]! * wi;
        const ti = re[b]! * wi + im[b]! * wr;
        re[b] = ar - tr;
        im[b] = ai - ti;
        re[a] = ar + tr;
        im[a] = ai + ti;
        const nwr = wr * wpr - wi * wpi;
        wi = wr * wpi + wi * wpr;
        wr = nwr;
      }
    }
  }
}

export class SendspinVisualizer {
  private readonly opts: VisualizerDspOptions;
  private readonly bytesPerSample: number;
  private readonly frameBytes: number; // bytes per multi-channel sample
  /** Samples per analysis window at this stream's rate; see windowSizeFor. */
  private readonly windowSize: number;
  /** The mono (mid) signal, for everything that needs a waveform: FFT, pitch. */
  private readonly ring: Float64Array;
  /** Per-frame mean of squares across channels, for everything that needs a level. */
  private readonly ringPow: Float64Array;
  private ringFilled = 0;
  private ringPos = 0;
  private readonly emitIntervalUs: number;
  private lastEmitTs: number | null = null;
  private readonly hann: Float64Array;
  /**
   * Per-display-bin FFT plan: the inclusive FFT-bin range the band covers, or an
   * empty range (hi < lo) plus a fractional bin to read by interpolation. See the
   * constructor for why both cases exist.
   */
  private readonly dispLoK: Int32Array | null;
  private readonly dispHiK: Int32Array | null;
  private readonly dispCenterK: Float64Array | null;
  private readonly spectrumState: Float64Array | null;
  private lastSpectrumTs: number | null = null;
  // Onset-detector state.
  private emaEnergy = 0;
  private lastPeakTs: number | null = null;
  // Pitch autocorrelation lag bounds.
  private readonly pitchMinLag: number;
  private readonly pitchMaxLag: number;

  constructor(options: VisualizerDspOptions) {
    this.opts = options;
    this.bytesPerSample = Math.max(1, Math.floor(options.bitDepth / 8));
    this.frameBytes = this.bytesPerSample * Math.max(1, options.channels);
    this.emitIntervalUs = Math.floor(1_000_000 / Math.max(1, options.rateMax));
    const window = windowSizeFor(options.sampleRate);
    this.windowSize = window;
    this.ring = new Float64Array(window);
    this.ringPow = new Float64Array(window);
    this.hann = new Float64Array(window);
    for (let i = 0; i < window; i += 1) {
      this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (window - 1));
    }

    /*
     * Bin plan, computed per *display* bin rather than per FFT bin.
     *
     * The obvious direction — walk the usable FFT bins and drop each into the display bin
     * its frequency falls in — silently loses bars. A log scale packs its bins closest
     * together at the bottom: 48 bins over 40 Hz–16 kHz makes the first one 5.3 Hz wide,
     * where the FFT resolves ~21 Hz. Several low display bins therefore
     * contain no FFT bin at all, and a map built in that direction leaves them at zero
     * forever — measured as 5 of 48 bars that could never light up, in exactly the octaves
     * where music has the most energy.
     *
     * So each display bin states what it needs instead: the FFT bins inside its band when
     * it is wider than the resolution (take the loudest — a band an octave wide at 16 kHz
     * spans 77 bins, and averaging them would make a treble tone read ~19 dB quieter than
     * the same tone in the bass), or, when the band is narrower than a single FFT bin, the
     * magnitude *at* its centre frequency, interpolated between the two bins around it.
     */
    const spectrum = options.spectrum;
    if (spectrum && spectrum.n_disp_bins > 0) {
      const nyquist = options.sampleRate / 2;
      const fMin = Math.max(1, Math.min(spectrum.f_min, nyquist - 1));
      const fMax = Math.max(fMin + 1, Math.min(spectrum.f_max, nyquist));
      const hzPerBin = options.sampleRate / window;
      const maxK = window / 2;
      const n = spectrum.n_disp_bins;
      const scaleLo = hzToScale(spectrum.scale, fMin);
      const scaleHi = hzToScale(spectrum.scale, fMax);
      const at = (fraction: number): number =>
        scaleToHz(spectrum.scale, scaleLo + (scaleHi - scaleLo) * fraction);
      this.dispLoK = new Int32Array(n);
      this.dispHiK = new Int32Array(n);
      this.dispCenterK = new Float64Array(n);
      for (let i = 0; i < n; i += 1) {
        // First FFT bin at or above the lower edge, last one strictly below the upper edge:
        // adjacent bands neither overlap nor skip a bin.
        const lo = Math.max(1, Math.ceil(at(i / n) / hzPerBin));
        const hi = Math.min(maxK, Math.ceil(at((i + 1) / n) / hzPerBin) - 1);
        this.dispLoK[i] = lo;
        this.dispHiK[i] = hi;
        // Clamped so the interpolation always has a k+1 to reach for.
        this.dispCenterK[i] = Math.max(1, Math.min(maxK - 1, at((i + 0.5) / n) / hzPerBin));
      }
      this.spectrumState = new Float64Array(n);
    } else {
      this.dispLoK = null;
      this.dispHiK = null;
      this.dispCenterK = null;
      this.spectrumState = null;
    }

    this.pitchMinLag = Math.max(1, Math.floor(options.sampleRate / PITCH_F_MAX));
    this.pitchMaxLag = Math.min(window - 1, Math.ceil(options.sampleRate / PITCH_F_MIN));
  }

  /** One channel's sample at a byte offset, as a float in [-1,1]. */
  private readChannel(buf: Buffer, offset: number): number {
    if (this.bytesPerSample === 2) {
      return buf.readInt16LE(offset) / 32768;
    }
    if (this.bytesPerSample === 3) {
      const raw = buf.readUIntLE(offset, 3);
      return (raw & 0x800000 ? raw - 0x1000000 : raw) / 8388608;
    }
    if (this.bytesPerSample === 4) {
      return buf.readInt32LE(offset) / 2147483648;
    }
    return (buf.readUInt8(offset) - 128) / 128;
  }

  /**
   * Feed one PCM audio frame; emits visualizer frames paced to rate_max.
   *
   * Two values are kept per audio frame. The mid mix (the channel average) is the signal
   * to analyse: it is what the FFT and the pitch autocorrelation need. It is the wrong
   * thing to measure a *level* with, though — averaging amplitudes cancels anything the
   * channels carry in opposite phase, so a deliberately wide stereo mix read quiet and its
   * onsets went undetected. The level therefore comes from the mean of the channel squares,
   * which no phase relationship can cancel.
   */
  push(pcm: Buffer, frameTsUs: number): void {
    const usable = pcm.length - (pcm.length % this.frameBytes);
    const ch = Math.max(1, this.opts.channels);
    for (let off = 0; off < usable; off += this.frameBytes) {
      let sum = 0;
      let sumSq = 0;
      for (let c = 0; c < ch; c += 1) {
        const v = this.readChannel(pcm, off + c * this.bytesPerSample);
        sum += v;
        sumSq += v * v;
      }
      this.ring[this.ringPos] = sum / ch;
      this.ringPow[this.ringPos] = sumSq / ch;
      this.ringPos = (this.ringPos + 1) % this.windowSize;
      if (this.ringFilled < this.windowSize) this.ringFilled += 1;
    }

    if (this.ringFilled < this.windowSize) return;
    if (this.lastEmitTs !== null && frameTsUs - this.lastEmitTs < this.emitIntervalUs) return;
    this.lastEmitTs = frameTsUs;
    this.emit(frameTsUs);
  }

  private emit(timestampUs: number): void {
    const o = this.opts;
    // Copy the ring into chronological order; sum the channel powers over the same window.
    const window = this.windowSize;
    const win = new Float64Array(window);
    let powSum = 0;
    for (let i = 0; i < window; i += 1) {
      const at = (this.ringPos + i) % window;
      win[i] = this.ring[at]!;
      powSum += this.ringPow[at]!;
    }
    const rms = Math.sqrt(powSum / window);

    if (o.emitLoudness && o.onLoudness) {
      o.onLoudness(ampToU16(rms), timestampUs);
    }

    if (o.emitPeak && o.onPeak) {
      this.detectPeak(powSum, timestampUs);
    }

    const wantSpectrum = !!(this.spectrumState && o.onSpectrum && o.spectrum);
    const wantFpeak = !!(o.emitFpeak && o.onFpeak);
    const wantPitch = !!(o.emitPitch && o.onPitch);
    if (!wantSpectrum && !wantFpeak && !wantPitch) {
      return;
    }

    // One windowed FFT shared by spectrum, f_peak and pitch.
    const re = new Float64Array(window);
    const im = new Float64Array(window);
    for (let i = 0; i < window; i += 1) re[i] = win[i]! * this.hann[i]!;
    fft(re, im);

    if (wantSpectrum) this.emitSpectrum(re, im, timestampUs);
    if (wantFpeak) this.emitFpeak(re, im, timestampUs);
    if (wantPitch) this.emitPitch(re, im, rms, timestampUs);
  }

  private emitSpectrum(re: Float64Array, im: Float64Array, timestampUs: number): void {
    const n = this.opts.spectrum!.n_disp_bins;
    const state = this.spectrumState!;
    const loK = this.dispLoK!;
    const hiK = this.dispHiK!;
    const centerK = this.dispCenterK!;
    // Full-scale normalization: a unit sine through a Hann window peaks near N/4.
    const norm = this.windowSize / 4;
    // Wall-clock decay, so the fall time does not follow the client's frame rate. A
    // timestamp that did not advance (or jumped backwards on a seek) starts clean.
    const elapsedMs =
      this.lastSpectrumTs === null ? Infinity : (timestampUs - this.lastSpectrumTs) / 1000;
    this.lastSpectrumTs = timestampUs;
    const decay = elapsedMs > 0 ? 2 ** (-elapsedMs / SPECTRUM_HALFLIFE_MS) : 0;

    const out = new Uint16Array(n);
    for (let i = 0; i < n; i += 1) {
      const lo = loK[i]!;
      const hi = hiK[i]!;
      let mag: number;
      if (hi >= lo) {
        let peakPower = 0;
        for (let k = lo; k <= hi; k += 1) {
          const power = re[k]! * re[k]! + im[k]! * im[k]!;
          if (power > peakPower) peakPower = power;
        }
        mag = Math.sqrt(peakPower) / norm;
      } else {
        // Band narrower than one FFT bin: read the magnitude at its centre frequency.
        const kf = centerK[i]!;
        const k0 = Math.floor(kf);
        const t = kf - k0;
        const m0 = Math.hypot(re[k0]!, im[k0]!);
        const m1 = Math.hypot(re[k0 + 1]!, im[k0 + 1]!);
        mag = (m0 + (m1 - m0) * t) / norm;
      }
      const value = Math.max(mag, state[i]! * decay);
      state[i] = value;
      out[i] = ampToU16(value);
    }
    this.opts.onSpectrum!(out, timestampUs);
  }

  /** Dominant FFT bin with parabolic sub-bin interpolation. */
  private emitFpeak(re: Float64Array, im: Float64Array, timestampUs: number): void {
    const half = this.windowSize / 2;
    let bestK = 1;
    let bestMag = -1;
    for (let k = 1; k < half; k += 1) {
      const mag = re[k]! * re[k]! + im[k]! * im[k]!;
      if (mag > bestMag) {
        bestMag = mag;
        bestK = k;
      }
    }
    const a = Math.hypot(re[bestK - 1]!, im[bestK - 1]!);
    const b = Math.hypot(re[bestK]!, im[bestK]!);
    const c = Math.hypot(re[bestK + 1] ?? 0, im[bestK + 1] ?? 0);
    const denom = a - 2 * b + c;
    const delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    const freq = ((bestK + delta) * this.opts.sampleRate) / this.windowSize;
    const amp = ampToU16(b / (this.windowSize / 4));
    this.opts.onFpeak!(Math.round(freq), amp, timestampUs);
  }

  /** Energy-onset detector against a running mean. */
  private detectPeak(energy: number, timestampUs: number): void {
    if (this.emaEnergy <= 0) {
      this.emaEnergy = energy;
      return;
    }
    const ratio = energy / this.emaEnergy;
    const recentEnough =
      this.lastPeakTs === null || timestampUs - this.lastPeakTs >= PEAK_MIN_GAP_US;
    if (ratio >= PEAK_THRESHOLD && recentEnough) {
      this.lastPeakTs = timestampUs;
      const strength = Math.max(0, Math.min(255, Math.round((ratio - 1) * 96)));
      this.opts.onPeak!(strength, timestampUs);
    }
    this.emaEnergy = this.emaEnergy * PEAK_EMA + energy * (1 - PEAK_EMA);
  }

  /**
   * Pitch via autocorrelation: r = IFFT(|X|^2), found as the real part of an
   * FFT of the power spectrum. The best lag in the pitch range gives the
   * period; normalized peak height is the confidence.
   */
  private emitPitch(re: Float64Array, im: Float64Array, rms: number, timestampUs: number): void {
    if (rms < PITCH_RMS_GATE) return;
    const power = new Float64Array(this.windowSize);
    const zero = new Float64Array(this.windowSize);
    for (let k = 0; k < this.windowSize; k += 1) power[k] = re[k]! * re[k]! + im[k]! * im[k]!;
    // |X|^2 is real and even, so FFT(power).re == IFFT(power)*N == autocorrelation*N.
    fft(power, zero);
    const r0 = power[0]!;
    if (r0 <= 0) return;
    let bestLag = -1;
    let bestVal = 0;
    for (let lag = this.pitchMinLag; lag <= this.pitchMaxLag; lag += 1) {
      const v = power[lag]!;
      if (v > bestVal) {
        bestVal = v;
        bestLag = lag;
      }
    }
    if (bestLag < 1) return;
    const confidence = bestVal / r0;
    if (confidence < PITCH_MIN_CONFIDENCE) return;
    // Parabolic interpolation around the autocorrelation peak for sub-sample lag.
    const a = power[bestLag - 1]!;
    const b = power[bestLag]!;
    const c = power[bestLag + 1] ?? 0;
    const denom = a - 2 * b + c;
    const delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    const freq = this.opts.sampleRate / (bestLag + delta);
    this.opts.onPitch!(freqToMidiQ88(freq), Math.round(Math.min(1, confidence) * 255), timestampUs);
  }
}
