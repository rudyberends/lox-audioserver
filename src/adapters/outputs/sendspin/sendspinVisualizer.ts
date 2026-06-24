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
 * extractor: loudness + spectrum (the iconic bars); beat/pitch/peak are left
 * for later.
 */

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
  spectrum?: SpectrumConfig;
  onLoudness?: (value: number, timestampUs: number) => void;
  onSpectrum?: (bins: Uint16Array, timestampUs: number) => void;
}

// 2048-sample window: ~43 ms at 48 kHz, matching the reference default. Must be
// a power of two for the radix-2 FFT.
const WINDOW_SIZE = 2048;
const DB_FLOOR = -60;
const U16_MAX = 65535;
// Per-bin decay so bars fall smoothly between attacks instead of flickering.
const SPECTRUM_DECAY = 0.6;

/** Map a linear amplitude in [0,1] to a u16 over a [-60,0] dB window. */
function ampToU16(amp: number): number {
  if (amp <= 0) return 0;
  const db = 20 * Math.log10(amp);
  const norm = Math.max(0, Math.min(1, (db - DB_FLOOR) / -DB_FLOOR));
  return Math.round(norm * U16_MAX);
}

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1);
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
  private readonly ring = new Float64Array(WINDOW_SIZE);
  private ringFilled = 0;
  private ringPos = 0;
  private readonly emitIntervalUs: number;
  private lastEmitTs: number | null = null;
  private readonly hann: Float64Array;
  // Precomputed FFT-bin -> display-bin map and per-display-bin smoothing state.
  private readonly binStart: number;
  private readonly binEnd: number;
  private readonly binIndex: Int32Array | null;
  private readonly spectrumState: Float64Array | null;

  constructor(options: VisualizerDspOptions) {
    this.opts = options;
    this.bytesPerSample = Math.max(1, Math.floor(options.bitDepth / 8));
    this.frameBytes = this.bytesPerSample * Math.max(1, options.channels);
    this.emitIntervalUs = Math.floor(1_000_000 / Math.max(1, options.rateMax));
    this.hann = new Float64Array(WINDOW_SIZE);
    for (let i = 0; i < WINDOW_SIZE; i += 1) {
      this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW_SIZE - 1));
    }

    const spectrum = options.spectrum;
    if (spectrum && spectrum.n_disp_bins > 0) {
      const nyquist = options.sampleRate / 2;
      const fMin = Math.max(1, Math.min(spectrum.f_min, nyquist - 1));
      const fMax = Math.max(fMin + 1, Math.min(spectrum.f_max, nyquist));
      const hzPerBin = options.sampleRate / WINDOW_SIZE;
      this.binStart = Math.max(1, Math.floor(fMin / hzPerBin));
      this.binEnd = Math.min(WINDOW_SIZE / 2, Math.ceil(fMax / hzPerBin));
      // Map each usable FFT bin to a display bin per the requested scale.
      this.binIndex = new Int32Array(WINDOW_SIZE / 2 + 1).fill(-1);
      const n = spectrum.n_disp_bins;
      const toScale = spectrum.scale === 'mel' ? hzToMel : spectrum.scale === 'log' ? Math.log : (x: number) => x;
      const fromScaleLo = toScale(fMin);
      const fromScaleHi = toScale(fMax);
      for (let k = this.binStart; k <= this.binEnd; k += 1) {
        const hz = k * hzPerBin;
        const s = toScale(hz);
        let disp = Math.floor(((s - fromScaleLo) / (fromScaleHi - fromScaleLo)) * n);
        if (disp < 0) disp = 0;
        if (disp >= n) disp = n - 1;
        this.binIndex[k] = disp;
      }
      void melToHz; // reserved for future inverse-mel binning
      this.spectrumState = new Float64Array(n);
    } else {
      this.binStart = 0;
      this.binEnd = 0;
      this.binIndex = null;
      this.spectrumState = null;
    }
  }

  /** Read one interleaved multi-channel sample at byte offset, averaged to mono in [-1,1]. */
  private readMono(buf: Buffer, offset: number): number {
    const ch = Math.max(1, this.opts.channels);
    let sum = 0;
    for (let c = 0; c < ch; c += 1) {
      const o = offset + c * this.bytesPerSample;
      let v: number;
      if (this.bytesPerSample === 2) {
        v = buf.readInt16LE(o) / 32768;
      } else if (this.bytesPerSample === 3) {
        const raw = buf.readUIntLE(o, 3);
        v = (raw & 0x800000 ? raw - 0x1000000 : raw) / 8388608;
      } else if (this.bytesPerSample === 4) {
        v = buf.readInt32LE(o) / 2147483648;
      } else {
        v = (buf.readUInt8(o) - 128) / 128;
      }
      sum += v;
    }
    return sum / ch;
  }

  /** Feed one PCM audio frame; emits visualizer frames paced to rate_max. */
  push(pcm: Buffer, frameTsUs: number): void {
    const usable = pcm.length - (pcm.length % this.frameBytes);
    for (let off = 0; off < usable; off += this.frameBytes) {
      this.ring[this.ringPos] = this.readMono(pcm, off);
      this.ringPos = (this.ringPos + 1) % WINDOW_SIZE;
      if (this.ringFilled < WINDOW_SIZE) this.ringFilled += 1;
    }

    if (this.ringFilled < WINDOW_SIZE) return;
    if (this.lastEmitTs !== null && frameTsUs - this.lastEmitTs < this.emitIntervalUs) return;
    this.lastEmitTs = frameTsUs;
    this.emit(frameTsUs);
  }

  private emit(timestampUs: number): void {
    // Copy the ring into chronological order.
    const win = new Float64Array(WINDOW_SIZE);
    for (let i = 0; i < WINDOW_SIZE; i += 1) {
      win[i] = this.ring[(this.ringPos + i) % WINDOW_SIZE]!;
    }

    if (this.opts.emitLoudness && this.opts.onLoudness) {
      let sumSq = 0;
      for (let i = 0; i < WINDOW_SIZE; i += 1) sumSq += win[i]! * win[i]!;
      const rms = Math.sqrt(sumSq / WINDOW_SIZE);
      this.opts.onLoudness(ampToU16(rms), timestampUs);
    }

    if (this.binIndex && this.spectrumState && this.opts.onSpectrum && this.opts.spectrum) {
      const re = new Float64Array(WINDOW_SIZE);
      const im = new Float64Array(WINDOW_SIZE);
      for (let i = 0; i < WINDOW_SIZE; i += 1) re[i] = win[i]! * this.hann[i]!;
      fft(re, im);

      const n = this.opts.spectrum.n_disp_bins;
      const peak = new Float64Array(n);
      // Full-scale normalization: a unit sine through a Hann window peaks near N/4.
      const norm = WINDOW_SIZE / 4;
      for (let k = this.binStart; k <= this.binEnd; k += 1) {
        const disp = this.binIndex[k]!;
        if (disp < 0) continue;
        const mag = Math.hypot(re[k]!, im[k]!) / norm;
        if (mag > peak[disp]!) peak[disp] = mag;
      }

      const out = new Uint16Array(n);
      for (let i = 0; i < n; i += 1) {
        const decayed = this.spectrumState[i]! * SPECTRUM_DECAY;
        const value = Math.max(peak[i]!, decayed);
        this.spectrumState[i] = value;
        out[i] = ampToU16(value);
      }
      this.opts.onSpectrum(out, timestampUs);
    }
  }
}
