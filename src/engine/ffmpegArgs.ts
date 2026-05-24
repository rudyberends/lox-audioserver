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
  ) {}

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

  /** Two-stage decoder args: source → s16le PCM at output sample-rate/channels. */
  public buildPcmDecoderArgs(): string[] {
    const { sampleRate, channels } = this.outputSettings;
    const pcmOut = [
      '-vn', '-acodec', 'pcm_s16le',
      '-ar', String(sampleRate), '-ac', String(channels),
      '-f', 's16le', 'pipe:1',
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
    const { sampleRate, channels } = this.outputSettings;
    const pcmOut = ['-vn', '-acodec', 'pcm_s16le', '-ar', String(sampleRate), '-ac', String(channels),
      '-f', 's16le', 'pipe:1'];
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

  /** Two-stage encoder args: PCM s16le on stdin → output profile on stdout. */
  public buildPcmEncoderArgs(): string[] {
    const { sampleRate, channels, pcmBitDepth, mp3Bitrate, fixedGainDb } = this.outputSettings;
    // -fflags nobuffer / -analyzeduration 0: without these, FFmpeg buffers ~5 s of raw
    // PCM from pipe:0 before producing its first output frame (probing raw input).
    // Since we fully specify the format, probing is unnecessary and wastes startup time.
    const pcmIn = [
      '-fflags', 'nobuffer', '-probesize', '32', '-analyzeduration', '0',
      '-f', 's16le', '-ar', String(sampleRate), '-ac', String(channels), '-i', 'pipe:0',
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
    if (Number.isFinite(fixedGainDb) && fixedGainDb !== 0) {
      filters.push(`volume=${fixedGainDb}dB`);
    }
    if (audioResampler.name === 'soxr' && !canBypassResampleForPipe) {
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
