import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import ffmpegStatic from 'ffmpeg-static';
import { createLogger } from '@/shared/logging/logger';
import {
  audioResampler,
  pcmCodecFromBitDepth,
  pcmFormatFromBitDepth,
  type AudioOutputSettings,
} from '@/engine/audioFormat';

export type PlaybackSource =
  | {
      kind: 'file';
      path: string;
      loop?: boolean;
      padTailSec?: number;
      preDelayMs?: number;
      /** Optional start offset in seconds. */
      startAtSec?: number;
      /** Whether ffmpeg should pace input with -re (default: true). */
      realTime?: boolean;
    }
  | {
      kind: 'url';
      url: string;
      headers?: Record<string, string>;
      decryptionKey?: string;
      tlsVerifyHost?: string;
      inputFormat?: string;
      logLevel?: string;
      /** Optional start offset in seconds. */
      startAtSec?: number;
      realTime?: boolean;
      lowLatency?: boolean;
      restartOnFailure?: boolean;
    }
  | {
      kind: 'pipe';
      path: string;
      format?: 's16le' | 's24le' | 's32le' | 's16be';
      sampleRate?: number;
      channels?: number;
      /** Whether ffmpeg should pace input with -re (default: true). */
      realTime?: boolean;
      /** Optional shared readable stream to feed directly (bypasses URL). */
      stream?: NodeJS.ReadableStream;
    };

export type OutputProfile = 'mp3' | 'aac' | 'pcm' | 'opus' | 'flac';

const DEFAULT_KILL_TIMEOUT_MS = 2000;

export class AudioSession {
  private readonly log = createLogger('Audio', 'Session');
  private readonly subscribers = new Set<PassThrough>();
  private readonly subscriberLabels = new Map<PassThrough, string>();
  private subscriberCounter = 0;
  private process?: ChildProcessWithoutNullStreams;
  private ending = false;
  private readonly ffmpegPath =
    typeof ffmpegStatic === 'string' && ffmpegStatic ? ffmpegStatic : 'ffmpeg';

  private readonly bufferQueue: Buffer[] = [];
  private bufferBytes = 0;
  private readonly maxBufferBytes: number;
  private readonly maxSubscriberLagBytes = 1024 * 1024; // guard slow clients
  private firstChunkLogged = false;
  private firstChunkPromise: Promise<boolean> | null = null;
  private firstChunkResolve: ((value: boolean) => void) | null = null;
  private bytesSinceLog = 0;
  private lastLogTs = 0;
  private totalBytes = 0;
  private lastBps = 0;
  private lastBpsTs = 0;
  private restartAttempts = 0;
  private readonly targetLeadMs: number;
  private lastStderrLine: string | null = null;
  private lastStderrAt: number | null = null;
  private lastErrorMessage: string | null = null;
  private lastErrorAt: number | null = null;
  private lastExitCode: number | null = null;
  private lastExitSignal: string | null = null;
  private lastExitAt: number | null = null;
  private startTs: number | null = null;
  private subscriberDropCount = 0;
  private lastSubscriberDropAt: number | null = null;
  private readonly sourcePadTailSec?: number;
  private readonly sourcePreDelayMs?: number;
  private readonly keepInitialBuffer: boolean;
  private readonly isAlertSource: boolean;
  private debugTapStream?: fs.WriteStream;
  private readonly debugTapEnabled: boolean;
  private pipeSourceStream?: NodeJS.ReadableStream;
  private pipeSourceDataListener?: (chunk: Buffer) => void;
  private pipeSourceErrorListener?: (err: any) => void;
  private killTimer?: NodeJS.Timeout;
  private readonly killTimeoutMs = DEFAULT_KILL_TIMEOUT_MS;
  private discardSubscribersOnStop = false;
  private stdoutPaused = false;
  private backpressureCount = 0;
  private readonly backpressureListeners = new Map<PassThrough, () => void>();

  constructor(
    private readonly zoneId: number,
    private readonly source: PlaybackSource,
    private readonly profile: OutputProfile,
    private readonly onTerminated: () => void,
    private readonly outputSettings: AudioOutputSettings,
  ) {
    const candidate = outputSettings.prebufferBytes;
    const hardMax = 1024 * 1024 * 4;
    const hardMin = 1024 * 8; // keep a small guard when enabled
    this.sourcePadTailSec =
      this.source.kind === 'file' && !this.source.loop ? this.source.padTailSec : undefined;
    this.sourcePreDelayMs =
      this.source.kind === 'file' && !this.source.loop ? this.source.preDelayMs : undefined;
    this.debugTapEnabled =
      this.profile === 'pcm' &&
      this.source.kind === 'file' &&
      typeof this.source.path === 'string' &&
      this.source.path.includes('/alerts/');
    // Fixed lead to reduce startup latency across outputs.
    this.targetLeadMs = 1000;
    const alertPrebufferMs = 6000;
    const isAlertSource =
      this.source.kind === 'file' &&
      typeof this.source.path === 'string' &&
      this.source.path.includes('/alerts/');
    this.isAlertSource = isAlertSource;
    this.keepInitialBuffer = isAlertSource;
    const alertBufferBytes = isAlertSource
      ? Math.round(
          (alertPrebufferMs / 1000) *
            (outputSettings.sampleRate * outputSettings.channels * (outputSettings.pcmBitDepth / 8)),
        )
      : 0;
    if (!Number.isFinite(candidate) || candidate <= 0) {
      // Allow disabling the rolling buffer; we still stream live without caching chunks.
      this.maxBufferBytes = 0;
    } else {
      // Allow larger prebuffer when upstream requests it (e.g., Sendspin wants ~5s).
      // Keep a safety cap to avoid unbounded memory; 4MB is still modest.
      const requested = Math.min(candidate, hardMax);
      this.maxBufferBytes = Math.max(requested, hardMin);
    }
    if (alertBufferBytes > 0) {
      const clampedAlert = Math.min(hardMax, Math.max(alertBufferBytes, hardMin));
      this.maxBufferBytes = Math.max(this.maxBufferBytes, clampedAlert);
    }
  }

  public start(): void {
    if (this.process) {
      return;
    }
    this.firstChunkLogged = false;
    this.firstChunkPromise = new Promise((resolve) => {
      this.firstChunkResolve = resolve;
    });
    this.log.info('audio session buffer config', {
      zoneId: this.zoneId,
      maxBufferBytes: this.maxBufferBytes,
      targetLeadMs: this.targetLeadMs,
      outputSampleRate: this.outputSettings.sampleRate,
      outputChannels: this.outputSettings.channels,
      outputBitDepth: this.outputSettings.pcmBitDepth,
      profile: this.profile,
    });

    if (this.source.kind === 'pipe' && this.source.stream) {
      const pipeSource = this.source as typeof this.source & { stream: NodeJS.ReadableStream };
      this.detachPipeSourceListeners();
      this.pipeSourceStream = pipeSource.stream;
      // Feed the stream through ffmpeg with -re to pace output.
      const fmt = this.source.format ?? 's16le';
      const sr = this.source.sampleRate ?? this.outputSettings.sampleRate;
      const ch = this.source.channels ?? 2;
      const paceInput = this.source.realTime !== false;
      // When pacing is enabled, apply -re so ffmpeg throttles to real-time. Without it,
      // ffmpeg may read from the upstream pipe as fast as possible which makes the
      // Sendspin timestamps run ahead of wall clock and causes the client to speed up.
      const inputArgs = [
        ...this.buildLowLatencyArgs({ includeProbe: false }),
        ...(paceInput ? ['-re'] : []),
        '-f',
        fmt,
        '-ar',
        String(sr),
        '-ac',
        String(ch),
        '-i',
        'pipe:0',
      ];
      const outputArgs = this.buildOutputArgs();
      const args = ['-hide_banner', '-loglevel', this.getLogLevel(), ...inputArgs, ...outputArgs, 'pipe:1'];

      this.log.debug('spawning ffmpeg (pipe stream)', {
        zoneId: this.zoneId,
        args,
        inputFormat: fmt,
        inputSampleRate: sr,
        inputChannels: ch,
        outputSampleRate: this.outputSettings.sampleRate,
        outputChannels: this.outputSettings.channels,
        outputBitDepth: this.outputSettings.pcmBitDepth,
        profile: this.profile,
      });
      this.startTs = Date.now();
      let proc: ChildProcessWithoutNullStreams;
      proc = this.spawnFfmpeg(args, {
        restartOnFailure: true,
        logFirstChunk: false,
        stdinStream: pipeSource.stream,
        onExit: () => {
          try {
            pipeSource.stream.unpipe(proc.stdin);
          } catch {
            /* ignore */
          }
        },
      });

      // Monitor incoming source stream for pacing visibility.
      let sourceBytesSinceLog = 0;
      let sourceLastLogTs = 0;
      let sourceFirstChunkLogged = false;
      this.pipeSourceDataListener = (chunk: Buffer) => {
        if (!chunk?.length) {
          return;
        }
        sourceBytesSinceLog += chunk.length;
        if (!sourceFirstChunkLogged) {
          sourceFirstChunkLogged = true;
          this.log.info('pipe source first chunk', {
            zoneId: this.zoneId,
            bytes: chunk.length,
            format: fmt,
            sampleRate: sr,
            channels: ch,
          });
        }
        const now = Date.now();
        if (!sourceLastLogTs) {
          sourceLastLogTs = now;
          return;
        }
        const elapsed = now - sourceLastLogTs;
        if (elapsed >= 1000) {
          const bps = Math.round((sourceBytesSinceLog / elapsed) * 1000);
          this.log.spam('pipe source throughput', {
            zoneId: this.zoneId,
            bytesPerSec: bps,
          });
          sourceLastLogTs = now;
          sourceBytesSinceLog = 0;
        }
      };
      pipeSource.stream.on('data', this.pipeSourceDataListener);

      this.process = proc;
      this.restartAttempts = 0;
      return;
    }

    const args = [
      '-hide_banner',
      '-loglevel',
      this.getLogLevel(),
      ...this.buildInputArgs(),
      ...this.buildOutputArgs(),
      'pipe:1',
    ];

    this.log.debug('spawning ffmpeg', {
      zoneId: this.zoneId,
      args,
      outputSampleRate: this.outputSettings.sampleRate,
      outputChannels: this.outputSettings.channels,
      outputBitDepth: this.outputSettings.pcmBitDepth,
      profile: this.profile,
    });
    this.startTs = Date.now();
    const proc = this.spawnFfmpeg(args, {
      restartOnFailure: this.source.kind === 'url' && this.source.restartOnFailure === true,
      logFirstChunk: true,
    });

    this.process = proc;
    this.restartAttempts = 0;
  }

  private spawnFfmpeg(
    args: string[],
    options: {
      restartOnFailure?: boolean;
      logFirstChunk?: boolean;
      stdinStream?: NodeJS.ReadableStream;
      onExit?: () => void;
    } = {},
  ): ChildProcessWithoutNullStreams {
    const proc = spawn(this.ffmpegPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    if (options.stdinStream) {
      options.stdinStream.pipe(proc.stdin);
      if (this.pipeSourceStream && this.pipeSourceErrorListener) {
        this.pipeSourceStream.off('error', this.pipeSourceErrorListener);
      }
      this.pipeSourceStream = options.stdinStream;
      this.pipeSourceErrorListener = (err: any) => {
        this.log.warn('pipe source error', {
          zoneId: this.zoneId,
          message: err?.message || String(err),
        });
        proc.stdin.destroy();
      };
      options.stdinStream.on('error', this.pipeSourceErrorListener);
      proc.stdin.on('error', (err: any) => {
        if (err?.code === 'EPIPE') {
          this.log.debug('ffmpeg stdin closed (EPIPE)', { zoneId: this.zoneId });
        } else {
          this.log.warn('ffmpeg stdin error', {
            zoneId: this.zoneId,
            message: err?.message || String(err),
          });
        }
      });
    }

    proc.stdout.on('data', (chunk: Buffer) => {
      if (!chunk?.length) {
        return;
      }
      if (options.logFirstChunk !== false && !this.firstChunkLogged) {
        this.firstChunkLogged = true;
        if (this.firstChunkResolve) {
          this.firstChunkResolve(true);
          this.firstChunkResolve = null;
        }
        this.log.info('ffmpeg first chunk', {
          zoneId: this.zoneId,
          profile: this.profile,
          bytes: chunk.length,
        });
      }
      if (this.maxBufferBytes > 0 && this.bufferBytes < this.maxBufferBytes) {
        this.bufferQueue.push(chunk);
        this.bufferBytes += chunk.length;
        if (!this.keepInitialBuffer) {
          while (this.bufferBytes > this.maxBufferBytes && this.bufferQueue.length > 0) {
            const removed = this.bufferQueue.shift();
            if (removed) {
              this.bufferBytes -= removed.length;
            }
          }
        }
      }
      this.recordBytes(chunk.length);
      this.writeToSubscribers(chunk);
    });

    proc.stdout.on('close', () => {
      this.log.debug('ffmpeg stdout closed', { zoneId: this.zoneId });
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const message = chunk.toString().trim();
      if (message) {
        this.lastStderrLine = message;
        this.lastStderrAt = Date.now();
        this.log.debug('ffmpeg stderr', { zoneId: this.zoneId, message });
      }
    });

    proc.on('exit', (code, signal) => {
      this.lastExitAt = Date.now();
      const runMs =
        this.startTs != null && this.lastExitAt != null ? this.lastExitAt - this.startTs : null;
      const earlyExit = runMs !== null && (runMs < 1000 || this.totalBytes < 200 * 1024);
      this.lastExitCode = typeof code === 'number' ? code : null;
      this.lastExitSignal = signal ?? null;
      this.log.info('ffmpeg exited', {
        zoneId: this.zoneId,
        code,
        signal,
        stderr: this.lastStderrLine ?? undefined,
        stderrAt: this.lastStderrAt ?? undefined,
        totalBytes: this.totalBytes,
        bufferedBytes: this.bufferBytes,
        subscribers: this.subscribers.size,
        runMs,
        earlyExit,
      });
      options.onExit?.();
      const shouldRestart =
        options.restartOnFailure === true && !this.ending && code !== 0;
      this.cleanup({ suppressTermination: shouldRestart });
      if (shouldRestart) {
        this.restartAttempts += 1;
        setTimeout(() => this.start(), Math.min(500, 100 * this.restartAttempts));
      }
    });

    proc.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        this.log.error('ffmpeg binary not found', {
          zoneId: this.zoneId,
          path: this.ffmpegPath,
          hint: 'Install ffmpeg or set AUDIO_FFMPEG_PATH/FFMPEG_PATH env variables',
        });
      } else {
        this.log.error('ffmpeg error', { zoneId: this.zoneId, message: error.message });
      }
      this.lastErrorMessage = error.message;
      this.lastErrorAt = Date.now();
      this.cleanup();
    });

    return proc;
  }

  private getLogLevel(): string {
    if (this.source.kind === 'url' && this.source.logLevel) {
      return this.source.logLevel;
    }
    return 'error';
  }

  private buildLowLatencyArgs(options: { includeProbe?: boolean } = {}): string[] {
    const args = ['-fflags', 'nobuffer'];
    if (options.includeProbe !== false) {
      args.push('-probesize', '32k', '-analyzeduration', '0');
    }
    return args;
  }

  private buildBufferedArgs(): string[] {
    return ['-probesize', '256k', '-analyzeduration', '1M'];
  }

  private pauseStdout(): void {
    if (!this.process?.stdout || this.stdoutPaused) {
      return;
    }
    this.process.stdout.pause();
    this.stdoutPaused = true;
  }

  private resumeStdout(): void {
    if (!this.process?.stdout || !this.stdoutPaused || this.backpressureCount > 0) {
      return;
    }
    this.process.stdout.resume();
    this.stdoutPaused = false;
  }

  private addBackpressure(subscriber: PassThrough): void {
    if (this.backpressureListeners.has(subscriber)) {
      return;
    }
    const onDrain = () => {
      this.clearBackpressure(subscriber);
    };
    this.backpressureListeners.set(subscriber, onDrain);
    this.backpressureCount += 1;
    subscriber.once('drain', onDrain);
    this.pauseStdout();
  }

  private clearBackpressure(subscriber: PassThrough): void {
    const onDrain = this.backpressureListeners.get(subscriber);
    if (!onDrain) {
      return;
    }
    subscriber.off('drain', onDrain);
    this.backpressureListeners.delete(subscriber);
    this.backpressureCount = Math.max(0, this.backpressureCount - 1);
    this.resumeStdout();
  }

  private buildInputArgs(): string[] {
    if (this.source.kind === 'url') {
      const lowLatency = this.source.lowLatency !== false;
      const headerLines = this.source.headers ? this.formatHeaders(this.source.headers) : '';
      const headerArgs = headerLines ? ['-headers', headerLines] : [];
      const decryptionArgs = this.source.decryptionKey ? ['-decryption_key', this.source.decryptionKey] : [];
      const needsTlsVerifyHost = Boolean(this.source.tlsVerifyHost && /^https:/i.test(this.source.url));
      const tlsArgs = needsTlsVerifyHost ? ['-tls_verify', '0', '-verifyhost', this.source.tlsVerifyHost!] : [];
      const inputFormatArgs = this.source.inputFormat ? ['-f', this.source.inputFormat] : [];
      const realtimeArgs = this.source.realTime ? ['-re'] : [];
      const seekArgs = this.buildSeekArgs(this.source.startAtSec);
      return [
        ...(lowLatency ? this.buildLowLatencyArgs() : this.buildBufferedArgs()),
        '-reconnect',
        '1',
        '-reconnect_streamed',
        '1',
        '-reconnect_delay_max',
        '5',
        ...tlsArgs,
        ...decryptionArgs,
        ...headerArgs,
        ...inputFormatArgs,
        ...realtimeArgs,
        ...seekArgs,
        '-i',
        this.source.url,
      ];
    }

    if (this.source.kind === 'pipe') {
      const sampleRate = this.source.sampleRate ?? this.outputSettings.sampleRate;
      const channels = this.source.channels ?? this.outputSettings.channels;
      const format = this.source.format ?? 's16le';
      const paceInput = this.source.realTime !== false;
      return [
        ...this.buildLowLatencyArgs({ includeProbe: false }),
        ...(paceInput ? ['-re'] : []),
        '-f',
        format,
        '-ar',
        String(sampleRate),
        '-ac',
        String(channels),
        '-i',
        this.source.path,
      ];
    }

    const inputs: string[] = [];
    const loopArgs = this.source.loop ? ['-stream_loop', '-1'] : [];
    const inputLatencyArgs = this.isAlertSource ? this.buildBufferedArgs() : this.buildLowLatencyArgs();
    // Pace file sources in real-time so downstream outputs (e.g., Snapcast) don’t get flooded.
    const paceInput = this.source.realTime !== false;
    const realTimeArgs = paceInput ? ['-re'] : [];
    const seekArgs = this.buildSeekArgs(this.source.startAtSec);
    inputs.push(...inputLatencyArgs, ...loopArgs, ...realTimeArgs, ...seekArgs, '-i', this.source.path);
    return inputs;
  }

  private buildSeekArgs(startAtSec?: number): string[] {
    if (!Number.isFinite(startAtSec)) {
      return [];
    }
    const safe = Math.max(0, startAtSec ?? 0);
    if (safe <= 0) {
      return [];
    }
    return ['-ss', String(safe)];
  }

  private formatHeaders(headers: Record<string, string>): string {
    const lines = Object.entries(headers)
      .filter(([, value]) => typeof value === 'string' && value.length > 0)
      .map(([key, value]) => `${key}: ${value}`);
    if (!lines.length) {
      return '';
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  private buildOutputArgs(): string[] {
    const { sampleRate, channels, pcmBitDepth, mp3Bitrate, fixedGainDb } = this.outputSettings;
    const buildFilterArgs = (): { filterArgs: string[] } => {
      const filters: string[] = [];
      if (this.sourcePreDelayMs && this.sourcePreDelayMs > 0) {
        const delayMs = Math.max(0, Math.round(this.sourcePreDelayMs));
        filters.push(`adelay=delays=${delayMs}:all=1`);
      }
      if (this.sourcePadTailSec && this.sourcePadTailSec > 0) {
        filters.push(`apad=pad_dur=${this.sourcePadTailSec}`);
      }
      if (Number.isFinite(fixedGainDb) && fixedGainDb !== 0) {
        filters.push(`volume=${fixedGainDb}dB`);
      }
      if (audioResampler.name === 'soxr') {
        filters.push(
          `aresample=resampler=soxr:precision=${audioResampler.precision}:cutoff=${audioResampler.cutoff}:async=1`,
        );
      }

      return { filterArgs: filters.length ? ['-af', filters.join(',')] : [] };
    };

    const { filterArgs } = buildFilterArgs();
    switch (this.profile) {
      case 'aac': {
        const bitrate = mp3Bitrate || '160k';
        return [
          '-vn',
          '-acodec',
          'aac',
          '-ar',
          String(sampleRate),
          '-ac',
          String(channels),
          '-b:a',
          bitrate,
          ...filterArgs,
          '-f',
          'adts',
        ];
      }
      case 'pcm': {
        const pcmCodec = pcmCodecFromBitDepth(pcmBitDepth);
        const pcmFormat = pcmFormatFromBitDepth(pcmBitDepth);
        return [
          '-vn',
          '-acodec',
          pcmCodec,
          '-ar',
          String(sampleRate),
          '-ac',
          String(channels),
          ...filterArgs,
          '-f',
          pcmFormat,
        ];
      }
      case 'opus': {
        const bitrate = mp3Bitrate || '160k';
        return [
          '-vn',
          '-acodec',
          'libopus',
          '-application',
          'audio',
          '-b:a',
          bitrate,
          '-ar',
          String(sampleRate),
          '-ac',
          String(channels),
          ...filterArgs,
          '-f',
          'opus',
        ];
      }
      case 'flac': {
        return [
          '-vn',
          '-acodec',
          'flac',
          '-compression_level',
          '5',
          '-ar',
          String(sampleRate),
          '-ac',
          String(channels),
          ...filterArgs,
          '-f',
          'flac',
        ];
      }
      case 'mp3':
      default:
        return [
          '-vn',
          '-acodec',
          'libmp3lame',
          '-ar',
          String(sampleRate),
          '-ac',
          String(channels),
          '-b:a',
          mp3Bitrate,
          ...filterArgs,
          '-f',
          'mp3',
        ];
    }
  }

  public stop(discardSubscribers = false): void {
    if (this.ending) {
      return;
    }
    this.ending = true;
    this.discardSubscribersOnStop = discardSubscribers;
    if (this.process) {
      this.process.kill('SIGTERM');
      this.armKillTimer();
    } else {
      this.cleanup();
    }
  }

  public async waitForFirstChunk(timeoutMs = 2000): Promise<boolean> {
    if (this.firstChunkLogged) {
      return true;
    }
    const pending = this.firstChunkPromise;
    if (!pending) {
      return false;
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void pending.then((ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
    });
  }

  public createSubscriber(options: { primeWithBuffer?: boolean; label?: string } = {}): PassThrough | null {
    if (!this.process) {
      return null;
    }
    const stream = new PassThrough({ highWaterMark: 1024 * 512 });
    // Prime the subscriber with buffered audio to prevent initial starvation unless disabled.
    if (options.primeWithBuffer !== false && this.bufferQueue.length) {
      for (const chunk of this.bufferQueue) {
        stream.write(chunk);
      }
    }
    this.subscribers.add(stream);
    if (this.subscribers.size === 1) {
      this.resumeStdout();
    }
    const label = options.label ?? `sub-${++this.subscriberCounter}`;
    this.subscriberLabels.set(stream, label);
    this.log.debug('audio subscriber attached', {
      zoneId: this.zoneId,
      profile: this.profile,
      label,
      subscriberCount: this.subscribers.size,
    });
    const remove = () => {
      this.clearBackpressure(stream);
      if (this.subscribers.delete(stream)) {
        const tag = this.subscriberLabels.get(stream);
        this.subscriberLabels.delete(stream);
        this.log.debug('audio subscriber detached', {
          zoneId: this.zoneId,
          profile: this.profile,
          label: tag ?? label,
          subscriberCount: this.subscribers.size,
        });
        if (this.subscribers.size === 0) {
          this.pauseStdout();
        }
      }
    };
    stream.on('close', remove);
    stream.on('error', remove);
    return stream;
  }

  public getStats(): {
    profile: OutputProfile;
    bps: number | null;
    bufferedBytes: number;
    totalBytes: number;
    lastUpdated: number | null;
    subscribers: number;
    restarts: number;
    lastError: string | null;
    lastErrorAt: number | null;
    lastStderr: string | null;
    lastStderrAt: number | null;
    lastExitCode: number | null;
    lastExitSignal: string | null;
    lastExitAt: number | null;
    subscriberDrops: number;
    lastSubscriberDropAt: number | null;
    } {
    const subscriberCount = this.subscribers.size;
    return {
      profile: this.profile,
      bps: this.lastBpsTs ? this.lastBps : null,
      bufferedBytes: this.bufferBytes,
      totalBytes: this.totalBytes,
      lastUpdated: this.lastBpsTs || null,
      subscribers: subscriberCount,
      restarts: this.restartAttempts,
      lastError: this.lastErrorMessage,
      lastErrorAt: this.lastErrorAt,
      lastStderr: this.lastStderrLine,
      lastStderrAt: this.lastStderrAt,
      lastExitCode: this.lastExitCode,
      lastExitSignal: this.lastExitSignal,
      lastExitAt: this.lastExitAt,
      subscriberDrops: this.subscriberDropCount,
      lastSubscriberDropAt: this.lastSubscriberDropAt,
    };
  }

  private cleanup(options: { suppressTermination?: boolean } = {}): void {
    const suppressTermination = options.suppressTermination === true;
    this.bytesSinceLog = 0;
    this.lastLogTs = 0;
    this.clearKillTimer();
    this.detachPipeSourceListeners();
    if (this.firstChunkResolve) {
      this.firstChunkResolve(false);
      this.firstChunkResolve = null;
    }
    this.firstChunkPromise = null;
    if (this.process) {
      this.process.removeAllListeners();
      this.process.stdout?.removeAllListeners();
      this.process.stderr?.removeAllListeners();
      this.process = undefined;
    }
    for (const [subscriber, onDrain] of this.backpressureListeners.entries()) {
      subscriber.off('drain', onDrain);
    }
    this.backpressureListeners.clear();
    this.backpressureCount = 0;
    this.stdoutPaused = false;
    for (const subscriber of this.subscribers) {
      if (subscriber.writableEnded) {
        continue;
      }
      if (this.discardSubscribersOnStop) {
        subscriber.destroy();
      } else {
        subscriber.end();
      }
    }
    if (this.debugTapStream) {
      try {
        this.debugTapStream.end();
      } catch {
        /* ignore */
      }
      this.debugTapStream = undefined;
    }
    this.subscribers.clear();
    this.discardSubscribersOnStop = false;
    if (!suppressTermination) {
      this.onTerminated();
    }
  }

  private writeToSubscribers(chunk: Buffer): void {
    for (const subscriber of Array.from(this.subscribers)) {
      if (subscriber.writableEnded) {
        this.clearBackpressure(subscriber);
        this.subscribers.delete(subscriber);
        if (this.subscribers.size === 0) {
          this.pauseStdout();
        }
        continue;
      }
      const ok = subscriber.write(chunk);
      if (!ok) {
        const pending = (subscriber as any)?._writableState?.length ?? 0;
        this.addBackpressure(subscriber);
        if (pending > this.maxSubscriberLagBytes) {
          subscriber.destroy();
          this.subscribers.delete(subscriber);
          this.clearBackpressure(subscriber);
          this.subscriberDropCount += 1;
          this.lastSubscriberDropAt = Date.now();
        }
      }
    }
  }

  private maybeLogThroughput(): void {
    const now = Date.now();
    if (!this.lastLogTs) {
      this.lastLogTs = now;
      return;
    }
    const elapsed = now - this.lastLogTs;
    if (elapsed < 1000) {
      return;
    }
    const bytesPerSec = Math.round((this.bytesSinceLog / elapsed) * 1000);
    this.lastBps = bytesPerSec;
    this.lastBpsTs = now;
    this.log.spam('pipe throughput', {
      zoneId: this.zoneId,
      profile: this.profile,
      bytesPerSec,
      bufferBytes: this.bufferBytes,
      subscribers: this.subscribers.size,
      labels: Array.from(this.subscriberLabels.values()),
    });
    this.lastLogTs = now;
    this.bytesSinceLog = 0;
  }

  private recordBytes(length: number): void {
    this.bytesSinceLog += length;
    this.totalBytes += length;
    this.maybeLogThroughput();
  }

  private armKillTimer(): void {
    this.clearKillTimer();
    this.killTimer = setTimeout(() => {
      if (this.process && !this.process.killed) {
        this.process.kill('SIGKILL');
      }
    }, this.killTimeoutMs);
  }

  private clearKillTimer(): void {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = undefined;
    }
  }

  private detachPipeSourceListeners(): void {
    if (this.pipeSourceStream && this.pipeSourceDataListener) {
      this.pipeSourceStream.off('data', this.pipeSourceDataListener);
    }
    if (this.pipeSourceStream && this.pipeSourceErrorListener) {
      this.pipeSourceStream.off('error', this.pipeSourceErrorListener);
    }
    this.pipeSourceStream = undefined;
    this.pipeSourceDataListener = undefined;
    this.pipeSourceErrorListener = undefined;
  }
}
