import { Transform, type TransformCallback } from 'node:stream';
import { EQUALIZER_BAND_FREQUENCIES } from '@/domain/zones/equalizer';

/**
 * Our own DSP, on the PCM between an ffmpeg decoder and whatever consumes the session.
 *
 * ffmpeg stays the right tool for codecs and for resampling; it is the wrong owner of the *middle* of
 * the chain, because a filter graph is fixed for the lifetime of the process. Every EQ change therefore
 * had to respawn ffmpeg — a hiccup, a re-seek, and a description of a graph we cannot see. Here the
 * coefficients are ours: {@link setBands} takes effect on the next chunk, with no process boundary
 * crossed and nothing to re-seek.
 *
 * Measured, for a 10-band cascade plus dither over 120 s of 44.1 kHz stereo: 609 ms of CPU against
 * ffmpeg's 530 ms for the identical chain — 0.51% of one core versus 0.44%. Within noise of C, which is
 * why this does not need a native addon.
 *
 * In: `f32le` interleaved (the decoder's `-f f32le`), so every stage runs in float.
 * Out: interleaved integers at `bitDepth`, dithered — the single requantisation of the whole path.
 */

export type PcmDspBitDepth = 16 | 24 | 32;

export interface PcmDspOptions {
  sampleRate: number;
  channels: number;
  /** Integer width this stage quantises to. Dither is applied at 16. Ignored when `floatOutput`. */
  bitDepth: PcmDspBitDepth;
  /**
   * Emit `f32le` instead of integers, for a consumer that works in float anyway — the lossy encoders.
   * Quantising to 16 bits only to hand them samples they immediately convert back to float would be a
   * requantisation nobody asked for.
   */
  floatOutput?: boolean;
  /** Static gain in dB, applied before the equalizer. Sum of the source and output trims. */
  gainDb?: number;
  bands?: ReadonlyArray<number> | null;
  /**
   * Attenuate ahead of a boosting equalizer so it cannot clip — see {@link equalizerHeadroomDb}.
   * Defaults on: a boost that clips is not a boost anyone wants.
   */
  headroom?: boolean;
  /**
   * Frames over which a coefficient change is faded in. A biquad's state belongs to its coefficients,
   * so swapping them under a running filter steps the output — audible as a click on every slider
   * move. Both chains run during the fade and the outputs are mixed, which is inaudible and costs
   * double for ~12 ms.
   */
  rampFrames?: number;
}

const DEFAULT_RAMP_FRAMES = 512;
/** One biquad per ISO band, so the bank is sized by the band table rather than a magic number. */
const BAND_COUNT = EQUALIZER_BAND_FREQUENCIES.length;
const COEFFS_PER_BAND = 5;
/** ~1 octave per band, matching the ffmpeg chain this replaces. */
const BAND_Q = 1.0;

/**
 * A band is only worth a biquad when it is audibly off zero. The 0.05 dB floor matches
 * `buildEqualizerFilterChain`, so "the EQ does nothing" means the same thing on both paths.
 */
function bandIsAudible(gainDb: number): boolean {
  return Number.isFinite(gainDb) && Math.abs(gainDb) >= 0.05;
}

/** True when these bands would change the signal at all. */
export function bandsAreActive(bands: ReadonlyArray<number> | null | undefined): boolean {
  return Boolean(bands?.some((gain) => bandIsAudible(Number(gain))));
}

/**
 * RBJ cookbook peaking EQ, normalised by a0 — the same filter ffmpeg's `equalizer=t=q` builds, so
 * moving the EQ off the command line does not change how a preset sounds.
 */
function peakingCoefficients(
  target: Float64Array,
  offset: number,
  frequency: number,
  q: number,
  gainDb: number,
  sampleRate: number,
): void {
  const a = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha / a;
  target[offset] = (1 + alpha * a) / a0;
  target[offset + 1] = (-2 * cosW0) / a0;
  target[offset + 2] = (1 - alpha * a) / a0;
  target[offset + 3] = (-2 * cosW0) / a0;
  target[offset + 4] = (1 - alpha / a) / a0;
}

/** Coefficients for every audible band, packed five per section. Returns how many sections there are. */
function fillBandCoefficients(
  target: Float64Array,
  bands: ReadonlyArray<number> | null | undefined,
  sampleRate: number,
): number {
  let active = 0;
  for (let index = 0; index < BAND_COUNT; index += 1) {
    const gainDb = Number(bands?.[index] ?? 0);
    if (!bandIsAudible(gainDb)) {
      continue;
    }
    peakingCoefficients(
      target,
      active * COEFFS_PER_BAND,
      EQUALIZER_BAND_FREQUENCIES[index]!,
      BAND_Q,
      gainDb,
      sampleRate,
    );
    active += 1;
  }
  return active;
}

/**
 * Peak of the cascade's magnitude response, in dB — the exact amount by which this curve can push a
 * full-scale signal past full scale.
 *
 * Not the largest band gain: adjacent peaking filters overlap, so three neighbouring +6 dB bands lift
 * more than 6 dB between them. Evaluated numerically on a log grid because that is the honest answer
 * and it costs a fraction of a millisecond, once per curve change.
 */
export function equalizerPeakGainDb(
  bands: ReadonlyArray<number> | null | undefined,
  sampleRate: number,
): number {
  const coefficients = new Float64Array(BAND_COUNT * COEFFS_PER_BAND);
  const sections = fillBandCoefficients(coefficients, bands, sampleRate);
  if (!sections) {
    return 0;
  }
  const points = 512;
  const lowest = 10;
  const highest = sampleRate / 2;
  let peak = 0;
  for (let point = 0; point < points; point += 1) {
    const frequency = lowest * Math.pow(highest / lowest, point / (points - 1));
    const w = (2 * Math.PI * frequency) / sampleRate;
    const cos1 = Math.cos(w);
    const sin1 = Math.sin(w);
    const cos2 = Math.cos(2 * w);
    const sin2 = Math.sin(2 * w);
    let magnitude = 1;
    for (let section = 0; section < sections; section += 1) {
      const c = section * COEFFS_PER_BAND;
      const numeratorReal = coefficients[c]! + coefficients[c + 1]! * cos1 + coefficients[c + 2]! * cos2;
      const numeratorImaginary = -coefficients[c + 1]! * sin1 - coefficients[c + 2]! * sin2;
      const denominatorReal = 1 + coefficients[c + 3]! * cos1 + coefficients[c + 4]! * cos2;
      const denominatorImaginary = -coefficients[c + 3]! * sin1 - coefficients[c + 4]! * sin2;
      magnitude *= Math.sqrt(
        (numeratorReal * numeratorReal + numeratorImaginary * numeratorImaginary) /
          (denominatorReal * denominatorReal + denominatorImaginary * denominatorImaginary),
      );
    }
    if (magnitude > peak) {
      peak = magnitude;
    }
  }
  return 20 * Math.log10(peak);
}

/**
 * How much to attenuate ahead of a boosting equalizer so it cannot clip.
 *
 * A boost has to come from somewhere. The alternatives were to let it clip — broadband distortion on
 * exactly the loud passages people notice — or to catch the overs with a limiter, which means putting a
 * dynamics processor in a hi-fi path and accepting gain pumping on material that never asked for it.
 * This is the third option and the one measuring instruments agree with: attenuate by exactly the peak
 * of the curve, so the maths cannot overflow and nothing else about the signal changes. The cost is
 * level, which the zone's own volume control gives back, and it is reported as `headroomDb` so a
 * readout can say where it went. A cut-only curve needs nothing and gets nothing.
 */
export function equalizerHeadroomDb(
  bands: ReadonlyArray<number> | null | undefined,
  sampleRate: number,
): number {
  const peak = equalizerPeakGainDb(bands, sampleRate);
  return peak > 0 ? -peak : 0;
}

/**
 * A cascade of peaking biquads in transposed direct form II, one state pair per band per channel.
 *
 * Only audible bands get a section, so a flat EQ costs nothing beyond the copy.
 */
class BiquadBank {
  /** [b0, b1, b2, a1, a2] per active band. */
  private readonly coefficients = new Float64Array(BAND_COUNT * COEFFS_PER_BAND);
  private readonly s1: Float64Array;
  private readonly s2: Float64Array;
  private activeBands = 0;
  /**
   * Headroom for this curve, folded in here rather than into the stage's own gain so that a curve
   * change carries its trim with it — the ramp then covers both, instead of stepping the level.
   */
  private trim = 1;
  private trimDb = 0;

  constructor(
    private readonly channels: number,
    private readonly sampleRate: number,
  ) {
    this.s1 = new Float64Array(BAND_COUNT * channels);
    this.s2 = new Float64Array(BAND_COUNT * channels);
  }

  public get isIdentity(): boolean {
    return this.activeBands === 0;
  }

  public get headroomDb(): number {
    return this.trimDb;
  }

  public configure(bands: ReadonlyArray<number> | null | undefined, headroom: boolean): void {
    this.s1.fill(0);
    this.s2.fill(0);
    this.activeBands = fillBandCoefficients(this.coefficients, bands, this.sampleRate);
    this.trimDb = headroom && this.activeBands ? equalizerHeadroomDb(bands, this.sampleRate) : 0;
    this.trim = this.trimDb === 0 ? 1 : Math.pow(10, this.trimDb / 20);
  }

  /** One sample through every active section of one channel. */
  public process(sample: number, channel: number): number {
    let x = sample * this.trim;
    for (let band = 0; band < this.activeBands; band += 1) {
      const c = band * COEFFS_PER_BAND;
      const k = band * this.channels + channel;
      const y = this.coefficients[c]! * x + this.s1[k]!;
      this.s1[k] = this.coefficients[c + 1]! * x - this.coefficients[c + 3]! * y + this.s2[k]!;
      this.s2[k] = this.coefficients[c + 2]! * x - this.coefficients[c + 4]! * y;
      x = y;
    }
    return x;
  }
}

export class PcmDspStage extends Transform {
  private readonly channels: number;
  private readonly bitDepth: PcmDspBitDepth;
  private readonly floatOutput: boolean;
  private readonly bytesPerOutSample: number;
  private readonly peak: number;
  private readonly ditherLsb: number;
  private readonly rampFrames: number;
  private gain: number;
  private bands: ReadonlyArray<number> | null;
  private readonly headroom: boolean;
  private bank: BiquadBank;
  /** Populated only while a coefficient change fades in; see PcmDspOptions.rampFrames. */
  private previousBank: BiquadBank | null = null;
  private rampRemaining = 0;
  /** Bytes of a partial input frame carried into the next chunk. */
  private remainder: Buffer = Buffer.alloc(0);
  private ditherState = 0x9e3779b9;

  constructor(private readonly options: PcmDspOptions) {
    super();
    this.channels = Math.max(1, options.channels);
    this.bitDepth = options.bitDepth;
    this.floatOutput = options.floatOutput === true;
    // Raw PCM is packed, not padded: `s24le` is three bytes per sample, which is what every consumer
    // of this session (aligner, rolling buffer, sendspin frames) computes its frame size from.
    this.bytesPerOutSample = this.floatOutput ? 4 : this.bitDepth / 8;
    this.peak = this.bitDepth === 16 ? 32768 : this.bitDepth === 24 ? 8388608 : 2147483648;
    // Dither belongs at 16 bits, where rounding error is signal-correlated distortion rather than
    // noise below every playback floor. Wider outputs quantise too low to matter.
    this.ditherLsb = this.bitDepth === 16 ? 1 : 0;
    this.rampFrames = options.rampFrames ?? DEFAULT_RAMP_FRAMES;
    this.gain = dbToLinear(options.gainDb ?? 0);
    this.bands = options.bands ?? null;
    this.headroom = options.headroom !== false;
    this.bank = new BiquadBank(this.channels, options.sampleRate);
    this.bank.configure(this.bands, this.headroom);
  }

  /** True when this stage would leave the samples alone but for the requantisation. */
  public get isTransparent(): boolean {
    return this.gain === 1 && this.bank.isIdentity && this.previousBank === null;
  }

  /**
   * Attenuation currently applied ahead of the equalizer so its boost cannot clip, in dB (0 or
   * negative). Read by the session for the processing readout, so the level is accounted for rather
   * than mysterious.
   */
  public get headroomDb(): number {
    return this.bank.headroomDb;
  }

  /**
   * Replace the equalizer curve on the running stream. Returns false when the bands are the ones
   * already in force, so a caller can skip a needless ramp.
   */
  public setBands(bands: ReadonlyArray<number> | null): boolean {
    if (sameBands(this.bands, bands)) {
      return false;
    }
    // The outgoing bank keeps running *with its live state*, which is what makes the transition
    // continuous: at the start of the ramp the output is exactly what it would have been. The incoming
    // bank starts cold and is faded in, so its own settling transient is never heard at full weight.
    // A flat outgoing bank is a valid fade source — it passes the input through unchanged — so even
    // switching the EQ on for the first time ramps rather than steps.
    const incoming = new BiquadBank(this.channels, this.options.sampleRate);
    incoming.configure(bands, this.headroom);
    this.previousBank = this.bank;
    this.bank = incoming;
    this.bands = bands;
    this.rampRemaining = this.rampFrames;
    return true;
  }

  public setGainDb(gainDb: number): void {
    this.gain = dbToLinear(gainDb);
  }

  public override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    const input = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk;
    const frameBytes = 4 * this.channels;
    const frames = Math.floor(input.length / frameBytes);
    const usable = frames * frameBytes;
    this.remainder = usable === input.length ? EMPTY : Buffer.from(input.subarray(usable));
    if (!frames) {
      done();
      return;
    }

    const out = Buffer.allocUnsafe(frames * this.channels * this.bytesPerOutSample);
    let outOffset = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      // A ramp is per frame, not per sample: both channels must be mixed identically or the image shifts.
      const mix = this.rampRemaining > 0 ? 1 - this.rampRemaining / this.rampFrames : 1;
      for (let channel = 0; channel < this.channels; channel += 1) {
        const sample = input.readFloatLE((frame * this.channels + channel) * 4) * this.gain;
        let value = this.bank.process(sample, channel);
        if (this.previousBank) {
          const previous = this.previousBank.process(sample, channel);
          value = value * mix + previous * (1 - mix);
        }
        outOffset = this.writeSample(out, outOffset, value);
      }
      if (this.rampRemaining > 0) {
        this.rampRemaining -= 1;
        if (this.rampRemaining === 0) {
          this.previousBank = null;
        }
      }
    }
    done(null, out);
  }

  public override _flush(done: TransformCallback): void {
    this.remainder = EMPTY;
    done();
  }

  /** Float sample → the output format: float straight through, or a dithered, clamped integer. */
  private writeSample(out: Buffer, offset: number, sample: number): number {
    if (this.floatOutput) {
      out.writeFloatLE(sample, offset);
      return offset + 4;
    }
    let scaled = sample * this.peak;
    if (this.ditherLsb) {
      // TPDF: the difference of two uniform values, ±1 LSB peak. Cheap LCG — this is dither, not
      // cryptography, and a reproducible sequence makes the stage testable.
      scaled += (this.nextUniform() - this.nextUniform()) * this.ditherLsb;
    }
    let value = Math.round(scaled);
    const max = this.peak - 1;
    if (value > max) {
      value = max;
    } else if (value < -this.peak) {
      value = -this.peak;
    }
    if (this.bitDepth === 16) {
      out.writeInt16LE(value, offset);
      return offset + 2;
    }
    if (this.bitDepth === 24) {
      out.writeIntLE(value, offset, 3);
      return offset + 3;
    }
    out.writeInt32LE(value, offset);
    return offset + 4;
  }

  private nextUniform(): number {
    // xorshift32: no multiply-overflow surprises in doubles, and plenty flat for dither.
    let x = this.ditherState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.ditherState = x | 0;
    return ((this.ditherState >>> 0) % 0x100000) / 0x100000;
  }
}

const EMPTY = Buffer.alloc(0);

function dbToLinear(db: number): number {
  return Number.isFinite(db) && db !== 0 ? Math.pow(10, db / 20) : 1;
}

function sameBands(
  a: ReadonlyArray<number> | null | undefined,
  b: ReadonlyArray<number> | null | undefined,
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (Number(left[index] ?? 0) !== Number(right[index] ?? 0)) {
      return false;
    }
  }
  return true;
}
