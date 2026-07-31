import {
  audioResampler,
  pcmCodecFromBitDepth,
  pcmFormatFromBitDepth,
  type AudioOutputSettings,
} from '@/engine/audioFormat';
import { buildEqualizerFilterChain } from '@/domain/zones/equalizer';
import type { OutputProfile, PlaybackSource } from '@/engine/audioSession';

// All three flags are required for truly low-latency pipe/stream sources:
//   -fflags nobuffer      – disable ffmpeg's input read-ahead buffer
//   -probesize 32k        – limit format probing to 32 KB (default 5 MB)
//   -analyzeduration 0    – skip the stream analysis phase entirely
// Even when the input format is explicitly specified with -f, ffmpeg still runs an
// analyze phase that reads ~200 KB (~1.1 s of 44.1 kHz stereo PCM) before producing
// any output. -fflags nobuffer alone does NOT suppress this — analyzeduration=0 is
// required to reduce the startup delay to ~50 ms.
export const FFMPEG_LOW_LATENCY_ARGS: readonly string[] = [
  '-fflags', 'nobuffer', '-probesize', '32k', '-analyzeduration', '0',
];
export const FFMPEG_BUFFERED_ARGS: readonly string[] = [
  '-probesize', '256k', '-analyzeduration', '1M',
];

export type FadeInSource =
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string; headers?: Record<string, string>; decryptionKey?: string };

/**
 * Native format of the source, either probed (local files) or declared by the
 * provider (stream URLs). Supplied only when the caller wants an untouched
 * passthrough path; when absent the builder behaves exactly as before (always
 * resample).
 */
export interface SourceNativeFormat {
  sampleRate: number;
  channels: number;
  /** Null when the source has no meaningful sample depth (lossy codecs). */
  bitDepth: number | null;
  /**
   * Whether the source codec preserves its input samples. Informational for
   * callers/logging — it does not gate passthrough, since not touching a lossy
   * stream is still not touching it.
   */
  lossless: boolean;
  codecName?: string;
}

/**
 * Every way this server can alter the audio, as data.
 *
 * The player's signal path used to be built from two booleans (`bitPerfect`, `dspApplied`), which is
 * enough to say *whether* something happened and nothing about what — and "DSP applied" over a chain
 * that might have resampled, requantised, gained, delayed, equalised or re-encoded is exactly the
 * vagueness a technical readout exists to remove.
 *
 * It is produced by the same object that builds the command line, from the same fields, so a stage
 * cannot be described as absent while its filter is in the args. Anything added to `buildFilterArgs`
 * or `buildOutputArgs` belongs here in the same commit.
 */
export interface ProcessingChain {
  /** soxr engaged: rate, channel count or depth had to change (or a filter forced the path). */
  resampled: boolean;
  /** The resampler's own settings, when it ran. */
  resampler: { name: string; precision: number; cutoff: number } | null;
  /** Sample depth changed — the source declared one and the output carries another. */
  requantised: boolean;
  /** Channel count changed: a downmix or an upmix. */
  channelsRemapped: boolean;
  /** The output codec re-encodes rather than carrying samples (aac, mp3, opus). */
  reencoded: boolean;
  /** The zone's 10-band equalizer, when any band is off zero. */
  equalizer: { bands: number[] } | null;
  /**
   * Gain in dB, split by where it comes from: the source's own loudness normalisation (Spotify sends
   * one) and the output's fixed trim. `0` means untouched — this is not the zone's volume, which the
   * player applies at the device and never here.
   */
  gainDb: { source: number; output: number } | null;
  /** Pre-delay in ms, for aligning a source against another output. */
  delayMs: number | null;
}

/**
 * Builds the ffmpeg command-line for an audio session. All state needed by the
 * various build* helpers (source, profile, output settings, alert flag,
 * pre-delay) is supplied in the constructor; only EQ bands vary per call.
 */
export class FfmpegArgBuilder {
  constructor(
    private readonly source: PlaybackSource,
    private readonly profile: OutputProfile,
    private readonly outputSettings: AudioOutputSettings,
    private readonly isAlertSource: boolean,
    private readonly sourcePreDelayMs: number | undefined,
    /**
     * Probed native format of the source. When it matches the output settings
     * exactly and no DSP is active, the soxr resampler is omitted so samples
     * reach the sink untouched. Undefined = legacy behaviour (always resample).
     */
    private readonly sourceNativeFormat?: SourceNativeFormat,
  ) {}

  /**
   * True when we do not touch the audio: the source reaches the player exactly as
   * the provider delivered it, with no rate conversion, no requantisation and no
   * filtering on our side.
   *
   * This is the project's definition of bit-perfect — "we don't come near it" —
   * and it deliberately says nothing about whether the *source* is lossless. A
   * 44.1 kHz AAC stream served at 44.1 kHz is bit-perfect by this definition: we
   * pass Apple's decode through untouched. That the encoder threw information away
   * upstream is their choice, not our alteration.
   *
   * Each condition is load-bearing:
   *  - rate/channels equal: any mismatch genuinely needs a converter.
   *  - depth: only enforced when the source declares one. A lossy source has no
   *    original sample depth to preserve, so whatever depth we carry it in cannot
   *    lose anything; a lossless source at a different depth *would* be requantised.
   *  - PCM or FLAC profile: the lossy encoders re-encode by definition.
   *  - no pre-delay, gain or EQ: each forces ffmpeg into filtered processing.
   */
  public isBitPerfect(equalizerBands: ReadonlyArray<number> | null): boolean {
    const native = this.sourceNativeFormat;
    if (!native) {
      return false;
    }
    if (this.profile !== 'pcm' && this.profile !== 'flac') {
      return false;
    }
    const { sampleRate, channels, pcmBitDepth, fixedGainDb } = this.outputSettings;
    if (native.sampleRate !== sampleRate || native.channels !== channels) {
      return false;
    }
    // A declared depth must match; an undeclared one (lossy source) cannot be lost.
    if (native.bitDepth !== null && native.bitDepth !== pcmBitDepth) {
      return false;
    }
    if (this.sourcePreDelayMs && this.sourcePreDelayMs > 0) {
      return false;
    }
    if (Number.isFinite(fixedGainDb) && fixedGainDb !== 0) {
      return false;
    }
    const sourceGainDb = this.source.kind === 'url' ? this.source.gainDb : undefined;
    if (typeof sourceGainDb === 'number' && Number.isFinite(sourceGainDb) && sourceGainDb !== 0) {
      return false;
    }
    if (buildEqualizerFilterChain(equalizerBands)) {
      return false;
    }
    return true;
  }

  /**
   * What this session does to the audio, stage by stage.
   *
   * Read straight off the same inputs `buildFilterArgs` uses. `resampled` mirrors the *actual*
   * condition in that method rather than "rate differs", because a filter chain forces the resampler
   * even when the rates match — which is true and would otherwise be reported as a passthrough.
   */
  public describeProcessing(equalizerBands: ReadonlyArray<number> | null): ProcessingChain {
    const native = this.sourceNativeFormat;
    const { sampleRate, channels, pcmBitDepth, fixedGainDb } = this.outputSettings;
    const sourceGainDb = this.source.kind === 'url' ? this.source.gainDb : undefined;
    const eqChain = buildEqualizerFilterChain(equalizerBands);

    const pipeSourceSampleRate =
      this.source.kind === 'pipe' ? this.source.sampleRate ?? sampleRate : null;
    const pipeSourceChannels = this.source.kind === 'pipe' ? this.source.channels ?? channels : null;
    const pipeSourceFormat = this.source.kind === 'pipe' ? this.source.format ?? 's16le' : null;
    const canBypassResampleForPipe =
      (this.profile === 'pcm' || this.profile === 'flac') &&
      this.source.kind === 'pipe' &&
      pipeSourceFormat === 's16le' &&
      pipeSourceSampleRate === sampleRate &&
      pipeSourceChannels === channels;
    const resampled =
      audioResampler.name === 'soxr' &&
      !canBypassResampleForPipe &&
      !this.isBitPerfect(equalizerBands);

    const gainSource =
      typeof sourceGainDb === 'number' && Number.isFinite(sourceGainDb) ? sourceGainDb : 0;
    const gainOutput = Number.isFinite(fixedGainDb) ? fixedGainDb : 0;

    return {
      resampled,
      resampler: resampled ? { ...audioResampler } : null,
      // Only a *declared* depth can be lost; a lossy source has no original depth to preserve.
      requantised: native?.bitDepth != null && native.bitDepth !== pcmBitDepth,
      channelsRemapped: native != null && native.channels !== channels,
      reencoded: this.profile === 'aac' || this.profile === 'mp3' || this.profile === 'opus',
      equalizer: eqChain ? { bands: [...(equalizerBands ?? [])] } : null,
      gainDb: gainSource !== 0 || gainOutput !== 0 ? { source: gainSource, output: gainOutput } : null,
      delayMs: this.sourcePreDelayMs && this.sourcePreDelayMs > 0 ? this.sourcePreDelayMs : null,
    };
  }

  public getLogLevel(): string {
    if (this.source.kind === 'url' && this.source.logLevel) {
      return this.source.logLevel;
    }
    return 'error';
  }

  /** Single-stage input args based on source kind. */
  public buildInputArgs(): string[] {
    if (this.source.kind === 'url') {
      const lowLatency = this.source.lowLatency !== false;
      const headerLines = this.source.headers ? formatHeaders(this.source.headers) : '';
      const headerArgs = headerLines ? ['-headers', headerLines] : [];
      const decryptionArgs = this.source.decryptionKey ? ['-decryption_key', this.source.decryptionKey] : [];
      const needsTlsVerifyHost = Boolean(this.source.tlsVerifyHost && /^https:/i.test(this.source.url));
      const tlsArgs = needsTlsVerifyHost ? ['-tls_verify', '0', '-verifyhost', this.source.tlsVerifyHost!] : [];
      const inputFormatArgs = this.source.inputFormat ? ['-f', this.source.inputFormat] : [];
      // When URL input pacing is disabled (`realTime=false`), we rely on output backpressure to prevent
      // ffmpeg from running far ahead and exiting early on finite sources (e.g. Apple Music track MP4s).
      // That backpressure is computed using output bitrate; FLAC is variable so we can't pace it reliably
      // that way. For FLAC, force `-re` even when `realTime=false` to keep ffmpeg aligned with wall clock.
      const realtimeArgs =
        this.source.realTime === true || (this.source.realTime === false && this.profile === 'flac')
          ? ['-re']
          : [];
      return [
        ...(lowLatency ? FFMPEG_LOW_LATENCY_ARGS : FFMPEG_BUFFERED_ARGS),
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        ...tlsArgs, ...decryptionArgs, ...headerArgs, ...inputFormatArgs,
        ...realtimeArgs,
        ...buildSeekArgs(this.source.startAtSec),
        '-i', this.source.url,
      ];
    }

    if (this.source.kind === 'pipe') {
      const sampleRate = this.source.sampleRate ?? this.outputSettings.sampleRate;
      const channels = this.source.channels ?? this.outputSettings.channels;
      const format = this.source.format ?? 's16le';
      const paceInput = this.source.realTime !== false;
      return [
        ...FFMPEG_LOW_LATENCY_ARGS,
        ...(paceInput ? ['-re'] : []),
        '-f', format, '-ar', String(sampleRate), '-ac', String(channels),
        '-i', this.source.path,
      ];
    }

    const loopArgs = this.source.loop ? ['-stream_loop', '-1'] : [];
    const inputLatencyArgs = this.isAlertSource ? FFMPEG_BUFFERED_ARGS : FFMPEG_LOW_LATENCY_ARGS;
    // Pace file sources in real-time so downstream outputs (e.g., Snapcast) don't get flooded.
    const paceInput = this.source.realTime !== false;
    const realTimeArgs = paceInput ? ['-re'] : [];
    return [
      ...inputLatencyArgs, ...loopArgs, ...realTimeArgs,
      ...buildSeekArgs(this.source.startAtSec),
      '-i', this.source.path,
    ];
  }

  /** Single-stage output args with EQ + resample + pre-delay filters. */
  public buildOutputArgs(equalizerBands: ReadonlyArray<number> | null): string[] {
    const { sampleRate, channels, pcmBitDepth, mp3Bitrate, fixedGainDb } = this.outputSettings;
    const filterArgs = this.buildFilterArgs(equalizerBands, fixedGainDb);

    switch (this.profile) {
      case 'aac': {
        const bitrate = mp3Bitrate || '160k';
        return ['-vn', '-acodec', 'aac', '-ar', String(sampleRate), '-ac', String(channels),
          '-b:a', bitrate, ...filterArgs, '-f', 'adts'];
      }
      case 'pcm': {
        return ['-vn', '-acodec', pcmCodecFromBitDepth(pcmBitDepth),
          '-ar', String(sampleRate), '-ac', String(channels),
          ...filterArgs, '-f', pcmFormatFromBitDepth(pcmBitDepth)];
      }
      case 'opus': {
        const bitrate = mp3Bitrate || '160k';
        return ['-vn', '-acodec', 'libopus', '-application', 'audio', '-b:a', bitrate,
          '-ar', String(sampleRate), '-ac', String(channels),
          ...filterArgs, '-f', 'opus'];
      }
      case 'flac': {
        return ['-vn', '-acodec', 'flac', '-compression_level', '0', '-frame_size', '512',
          '-sample_fmt', flacSampleFormat(pcmBitDepth),
          '-ar', String(sampleRate), '-ac', String(channels),
          ...filterArgs, '-f', 'flac'];
      }
      case 'mp3':
      default:
        return ['-vn', '-acodec', 'libmp3lame',
          '-ar', String(sampleRate), '-ac', String(channels),
          '-b:a', mp3Bitrate, ...filterArgs, '-f', 'mp3'];
    }
  }

  /**
   * Two-stage decoder args: source → PCM at the output sample-rate/channels/depth.
   *
   * The intermediate bus carries the *negotiated* depth, not a fixed s16le. It used
   * to be hardcoded to 16-bit while the stage-2 encoder happily emitted pcm_s24le,
   * which silently produced 16-bit samples padded into 24-bit containers while
   * advertising 24-bit downstream.
   *
   * Note the two-stage path exists for crossfade, and crossfade blending itself
   * requantises — so this path is never bit-perfect. It is merely no longer
   * truncating.
   */
  public buildPcmDecoderArgs(): string[] {
    const { sampleRate, channels, pcmBitDepth } = this.outputSettings;
    const pcmOut = [
      '-vn', '-acodec', pcmCodecFromBitDepth(pcmBitDepth),
      '-ar', String(sampleRate), '-ac', String(channels),
      '-f', pcmFormatFromBitDepth(pcmBitDepth), 'pipe:1',
    ];
    const log = ['-hide_banner', '-loglevel', this.getLogLevel()];

    if (this.source.kind === 'file') {
      const loopArgs = this.source.loop ? ['-stream_loop', '-1'] : [];
      const latencyArgs = this.isAlertSource ? FFMPEG_BUFFERED_ARGS : FFMPEG_LOW_LATENCY_ARGS;
      const realTimeArgs = this.source.realTime !== false ? ['-re'] : [];
      return [...log, ...latencyArgs, ...loopArgs, ...realTimeArgs,
        ...buildSeekArgs(this.source.startAtSec), '-i', this.source.path, ...pcmOut];
    }

    if (this.source.kind === 'url') {
      const lowLatency = this.source.lowLatency !== false;
      const headerLines = this.source.headers ? formatHeaders(this.source.headers) : '';
      const headerArgs = headerLines ? ['-headers', headerLines] : [];
      const decryptionArgs = this.source.decryptionKey ? ['-decryption_key', this.source.decryptionKey] : [];
      const needsTls = Boolean(this.source.tlsVerifyHost && /^https:/i.test(this.source.url));
      const tlsArgs = needsTls ? ['-tls_verify', '0', '-verifyhost', this.source.tlsVerifyHost!] : [];
      const inputFormatArgs = this.source.inputFormat ? ['-f', this.source.inputFormat] : [];
      const realTimeArgs = this.source.realTime !== false ? ['-re'] : [];
      return [
        ...log,
        ...(lowLatency ? FFMPEG_LOW_LATENCY_ARGS : FFMPEG_BUFFERED_ARGS),
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        ...tlsArgs, ...decryptionArgs, ...headerArgs, ...inputFormatArgs,
        ...realTimeArgs, ...buildSeekArgs(this.source.startAtSec), '-i', this.source.url,
        ...pcmOut,
      ];
    }

    return [];
  }

  /** Decoder args for a fade-in source during an inline crossfade. */
  public buildPcmDecoderArgsForSource(source: FadeInSource): string[] {
    const { sampleRate, channels, pcmBitDepth } = this.outputSettings;
    const pcmOut = ['-vn', '-acodec', pcmCodecFromBitDepth(pcmBitDepth),
      '-ar', String(sampleRate), '-ac', String(channels),
      '-f', pcmFormatFromBitDepth(pcmBitDepth), 'pipe:1'];
    const log = ['-hide_banner', '-loglevel', this.getLogLevel()];

    if (source.kind === 'file') {
      return [...log, ...FFMPEG_LOW_LATENCY_ARGS, '-re', '-i', source.path, ...pcmOut];
    }

    const headerLines = source.headers ? formatHeaders(source.headers) : '';
    const headerArgs = headerLines ? ['-headers', headerLines] : [];
    const decryptionArgs = source.decryptionKey ? ['-decryption_key', source.decryptionKey] : [];
    return [
      ...log, ...FFMPEG_LOW_LATENCY_ARGS,
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      ...decryptionArgs, ...headerArgs, '-re', '-i', source.url,
      ...pcmOut,
    ];
  }

  /** Two-stage encoder args: PCM on stdin → output profile on stdout. */
  public buildPcmEncoderArgs(): string[] {
    const { sampleRate, channels, pcmBitDepth, mp3Bitrate, fixedGainDb } = this.outputSettings;
    // -fflags nobuffer / -analyzeduration 0: without these, FFmpeg buffers ~5 s of raw
    // PCM from pipe:0 before producing its first output frame (probing raw input).
    // Since we fully specify the format, probing is unnecessary and wastes startup time.
    // The input format must track buildPcmDecoderArgs' output depth exactly — these
    // two are the same pipe.
    const pcmIn = [
      '-fflags', 'nobuffer', '-probesize', '32', '-analyzeduration', '0',
      '-f', pcmFormatFromBitDepth(pcmBitDepth),
      '-ar', String(sampleRate), '-ac', String(channels), '-i', 'pipe:0',
    ];

    const filters: string[] = [];
    if (this.sourcePreDelayMs && this.sourcePreDelayMs > 0) {
      filters.push(`adelay=delays=${this.sourcePreDelayMs}:all=1`);
    }
    if (Number.isFinite(fixedGainDb) && fixedGainDb !== 0) {
      filters.push(`volume=${fixedGainDb}dB`);
    }
    const filterArgs = filters.length ? ['-af', filters.join(',')] : [];
    const log = ['-hide_banner', '-loglevel', this.getLogLevel()];
    const base = [...log, ...pcmIn, ...filterArgs];

    switch (this.profile) {
      case 'flac':
        return [...base, '-acodec', 'flac', '-compression_level', '0', '-frame_size', '512',
          '-sample_fmt', flacSampleFormat(pcmBitDepth),
          '-ar', String(sampleRate), '-ac', String(channels), '-f', 'flac', 'pipe:1'];
      case 'aac': {
        const br = mp3Bitrate || '160k';
        return [...base, '-acodec', 'aac', '-ar', String(sampleRate), '-ac', String(channels),
          '-b:a', br, '-f', 'adts', 'pipe:1'];
      }
      case 'pcm': {
        const codec = pcmCodecFromBitDepth(pcmBitDepth);
        const fmt = pcmFormatFromBitDepth(pcmBitDepth);
        return [...base, '-acodec', codec, '-ar', String(sampleRate), '-ac', String(channels),
          '-f', fmt, 'pipe:1'];
      }
      case 'opus': {
        const br = mp3Bitrate || '160k';
        return [...base, '-acodec', 'libopus', '-application', 'audio', '-b:a', br,
          '-ar', String(sampleRate), '-ac', String(channels), '-f', 'opus', 'pipe:1'];
      }
      case 'mp3':
      default: {
        const br = mp3Bitrate || '320k';
        return [...base, '-acodec', 'libmp3lame', '-ar', String(sampleRate), '-ac', String(channels),
          '-b:a', br, '-f', 'mp3', 'pipe:1'];
      }
    }
  }

  private buildFilterArgs(
    equalizerBands: ReadonlyArray<number> | null,
    fixedGainDb: number,
  ): string[] {
    const filters: string[] = [];
    const pipeSourceSampleRate =
      this.source.kind === 'pipe' ? this.source.sampleRate ?? this.outputSettings.sampleRate : null;
    const pipeSourceChannels =
      this.source.kind === 'pipe' ? this.source.channels ?? this.outputSettings.channels : null;
    const pipeSourceFormat = this.source.kind === 'pipe' ? this.source.format ?? 's16le' : null;
    const canBypassResampleForPipe =
      (this.profile === 'pcm' || this.profile === 'flac') &&
      this.source.kind === 'pipe' &&
      pipeSourceFormat === 's16le' &&
      pipeSourceSampleRate === this.outputSettings.sampleRate &&
      pipeSourceChannels === this.outputSettings.channels;

    if (this.sourcePreDelayMs && this.sourcePreDelayMs > 0) {
      filters.push(`adelay=delays=${Math.max(0, Math.round(this.sourcePreDelayMs))}:all=1`);
    }
    // Source-level loudness gain (e.g. Spotify volume normalisation). Composes
    // with the per-output fixedGainDb below rather than replacing it.
    const sourceGainDb = this.source.kind === 'url' ? this.source.gainDb : undefined;
    if (typeof sourceGainDb === 'number' && Number.isFinite(sourceGainDb) && sourceGainDb !== 0) {
      filters.push(`volume=${sourceGainDb.toFixed(2)}dB`);
    }
    if (Number.isFinite(fixedGainDb) && fixedGainDb !== 0) {
      filters.push(`volume=${fixedGainDb}dB`);
    }
    // Nothing about this session alters the audio, so the resampler would be a
    // pure no-op. Holds for lossy sources too — see isBitPerfect.
    const canBypassResampleForSource = this.isBitPerfect(equalizerBands);

    if (audioResampler.name === 'soxr' && !canBypassResampleForPipe && !canBypassResampleForSource) {
      // For live pipe inputs (e.g. librespot), ffmpeg's async resampling can build up
      // noticeable startup latency before first output chunk. Keep resampling enabled
      // but disable async clock correction for pipe sources.
      const asyncPart = this.source.kind === 'pipe' ? '' : ':async=1';
      filters.push(
        `aresample=resampler=soxr:precision=${audioResampler.precision}:cutoff=${audioResampler.cutoff}${asyncPart}`,
      );
    }
    const eqChain = buildEqualizerFilterChain(equalizerBands);
    if (eqChain) {
      filters.push(eqChain);
    }
    return filters.length ? ['-af', filters.join(',')] : [];
  }
}

/**
 * ffmpeg's FLAC encoder accepts only s16 and s32 as sample formats — there is no
 * s24. For 24-bit output we pass s32 and let the encoder derive a 24-bit
 * bits_per_raw_sample from the input's actual precision.
 *
 * Pinning this matters: without an explicit -sample_fmt the encoder negotiates
 * the format with the *decoder*, so a 24-bit source produced a 24-bit FLAC even
 * when the client had negotiated 16-bit. The STREAMINFO header we forward in
 * stream/start would then disagree with the frames, and the client decodes noise.
 */
function flacSampleFormat(bitDepth: number): string {
  return bitDepth === 16 ? 's16' : 's32';
}

function buildSeekArgs(startAtSec?: number): string[] {
  if (!Number.isFinite(startAtSec)) {
    return [];
  }
  const safe = Math.max(0, startAtSec ?? 0);
  if (safe <= 0) {
    return [];
  }
  return ['-ss', String(safe)];
}

function formatHeaders(headers: Record<string, string>): string {
  const lines = Object.entries(headers)
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([key, value]) => `${key}: ${value}`);
  if (!lines.length) {
    return '';
  }
  return `${lines.join('\r\n')}\r\n`;
}
