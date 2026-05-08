import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import ffmpegStatic from 'ffmpeg-static';
import { createLogger } from '@/shared/logging/logger';
import {
  audioResampler,
  mp3BitrateToBps,
  pcmCodecFromBitDepth,
  pcmFormatFromBitDepth,
  type AudioOutputSettings,
} from '@/engine/audioFormat';
import { buildEqualizerFilterChain } from '@/application/zones/equalizer';

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
      preDelayMs?: number;
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
      preDelayMs?: number;
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
const FLAC_SIGNATURE = Buffer.from('fLaC', 'ascii');

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
  private chainedFirstChunkResolve: ((value: boolean) => void) | null = null;
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
  private pipeSourceStream?: NodeJS.ReadableStream;
  private pipeSourceDataListener?: (chunk: Buffer) => void;
  private pipeSourceErrorListener?: (err: any) => void;
  private directPipeMode = false;
  private killTimer?: NodeJS.Timeout;
  private readonly killTimeoutMs = DEFAULT_KILL_TIMEOUT_MS;
  private discardSubscribersOnStop = false;
  private restartingForEq = false;
  private stdoutPaused = false;
  private backpressureCount = 0;
  private readonly backpressureListeners = new Map<PassThrough, () => void>();
  private readonly pacingBps: number | null;
  private readonly pacingMaxAheadBytes: number;
  private pacingPaused = false;
  private pacingTimer?: NodeJS.Timeout;
  // When streaming raw PCM, ensure we only emit full audio frames.
  // Otherwise, a subscriber that attaches mid-stream can start at an arbitrary byte offset,
  // which results in loud noise (misaligned sample boundaries).
  private readonly pcmFrameBytes: number | null;
  private pcmRemainder: Buffer | null = null;
  // For codec streams (FLAC, etc.), store the initial header so new subscribers
  // joining mid-stream can initialize their decoders correctly.
  private codecHeader: Buffer | null = null;

  constructor(
    private readonly zoneId: number,
    private readonly source: PlaybackSource,
    private readonly profile: OutputProfile,
    private readonly onTerminated: () => void,
    private readonly outputSettings: AudioOutputSettings,
    private equalizerBands: ReadonlyArray<number> | null = null,
  ) {
    const candidate = outputSettings.prebufferBytes;
    const hardMax = 1024 * 1024 * 4;
    const hardMin = 1024 * 8; // keep a small guard when enabled
    this.sourcePadTailSec =
      this.source.kind === 'file' && !this.source.loop ? this.source.padTailSec : undefined;
    this.sourcePreDelayMs = typeof this.source.preDelayMs === 'number' ? this.source.preDelayMs : undefined;
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

    // When URL input pacing is explicitly disabled (realTime=false), ffmpeg may process finite
    // sources (e.g. Apple Music track MP4s) far ahead of wall clock time and then exit,
    // terminating the session while pull-based outputs (Cast) still expect a live stream.
    // We prevent that by backpressuring ffmpeg stdout to keep a bounded lead buffer.
    this.pacingBps = this.computePacingBps();
    const minLeadBytes =
      this.pacingBps && this.targetLeadMs > 0
        ? Math.round((this.pacingBps * this.targetLeadMs) / 1000)
        : 0;
    this.pacingMaxAheadBytes = Math.max(minLeadBytes, this.maxBufferBytes, 0);

    this.pcmFrameBytes =
      this.profile === 'pcm'
        ? Math.max(1, Math.round(this.outputSettings.channels * (this.outputSettings.pcmBitDepth / 8)))
        : null;
  }

  private alignPcmChunk(chunk: Buffer): Buffer | null {
    const frameBytes = this.pcmFrameBytes;
    if (!frameBytes) {
      return chunk;
    }
    const combined =
      this.pcmRemainder && this.pcmRemainder.length
        ? Buffer.concat([this.pcmRemainder, chunk], this.pcmRemainder.length + chunk.length)
        : chunk;
    const alignedLen = Math.floor(combined.length / frameBytes) * frameBytes;
    if (alignedLen <= 0) {
      // Not enough bytes for a full frame yet; keep accumulating.
      this.pcmRemainder = Buffer.from(combined);
      return null;
    }
    const out = combined.subarray(0, alignedLen);
    const remLen = combined.length - alignedLen;
    this.pcmRemainder = remLen > 0 ? Buffer.from(combined.subarray(alignedLen)) : null;
    return out;
  }

  private isCodecHeaderChunk(chunk: Buffer): boolean {
    return (
      this.profile === 'flac' &&
      chunk.length >= FLAC_SIGNATURE.length &&
      chunk.subarray(0, FLAC_SIGNATURE.length).equals(FLAC_SIGNATURE)
    );
  }

  private bufferedChunkStartsWithCodecHeader(): boolean {
    const firstBufferedChunk = this.bufferQueue[0];
    return Boolean(firstBufferedChunk && this.isCodecHeaderChunk(firstBufferedChunk));
  }

  public start(): void {
    if (this.process) {
      return;
    }
    this.bufferQueue.length = 0;
    this.bufferBytes = 0;
    this.pcmRemainder = null;
    this.codecHeader = null;
    this.bytesSinceLog = 0;
    this.lastLogTs = 0;
    this.totalBytes = 0;
    this.firstChunkLogged = false;
    const chainedResolve = this.chainedFirstChunkResolve;
    this.chainedFirstChunkResolve = null;
    this.firstChunkPromise = new Promise((resolve) => {
      if (chainedResolve) {
        this.firstChunkResolve = (ok: boolean) => {
          resolve(ok);
          chainedResolve(ok);
        };
      } else {
        this.firstChunkResolve = resolve;
      }
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
      const fmt = this.source.format ?? 's16le';
      const sr = this.source.sampleRate ?? this.outputSettings.sampleRate;
      const ch = this.source.channels ?? 2;
      const canDirectPassthrough =
        this.profile === 'pcm' &&
        fmt === 's16le' &&
        sr === this.outputSettings.sampleRate &&
        ch === this.outputSettings.channels &&
        this.outputSettings.pcmBitDepth === 16 &&
        (!Number.isFinite(this.outputSettings.fixedGainDb) || this.outputSettings.fixedGainDb === 0) &&
        !this.sourcePreDelayMs &&
        !this.sourcePadTailSec;

      if (canDirectPassthrough) {
        this.directPipeMode = true;
        this.startTs = Date.now();
        this.log.info('using direct pipe passthrough', {
          zoneId: this.zoneId,
          profile: this.profile,
          format: fmt,
          sampleRate: sr,
          channels: ch,
        });

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
          } else {
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
          }

          const aligned = this.alignPcmChunk(chunk);
          if (!aligned?.length) {
            this.recordBytes(chunk.length);
            return;
          }
          if (!this.firstChunkLogged) {
            this.firstChunkLogged = true;
            if (this.firstChunkResolve) {
              this.firstChunkResolve(true);
              this.firstChunkResolve = null;
            }
            this.log.info('direct pipe first chunk', {
              zoneId: this.zoneId,
              profile: this.profile,
              bytes: aligned.length,
              spawnToFirstChunkMs: this.startTs ? Math.max(0, Date.now() - this.startTs) : null,
            });
          }
          this.bufferChunk(aligned);
          this.recordBytes(chunk.length);
          this.writeToSubscribers(aligned);
        };
        this.pipeSourceErrorListener = (err: any) => {
          this.log.warn('pipe source error', {
            zoneId: this.zoneId,
            message: err?.message || String(err),
          });
          if (!this.ending) {
            this.cleanup();
          }
        };
        pipeSource.stream.on('data', this.pipeSourceDataListener);
        pipeSource.stream.on('error', this.pipeSourceErrorListener);
        pipeSource.stream.once('end', () => {
          this.log.debug('pipe source ended', { zoneId: this.zoneId, profile: this.profile });
          if (!this.ending) {
            this.cleanup();
          }
        });
        pipeSource.stream.once('close', () => {
          this.log.debug('pipe source closed', { zoneId: this.zoneId, profile: this.profile });
          if (!this.ending) {
            this.cleanup();
          }
        });
        this.restartAttempts = 0;
        return;
      }

      const paceInput = this.source.realTime !== false;
      // When pacing is enabled, apply -re so ffmpeg throttles to real-time. Without it,
      // ffmpeg may read from the upstream pipe as fast as possible which makes the
      // Sendspin timestamps run ahead of wall clock and causes the client to speed up.
      // buildLowLatencyArgs() includes -probesize 32k -analyzeduration 0 even though the
      // format is explicitly specified via -f. This is intentional: even with an explicit
      // format, ffmpeg still runs an analyze phase that buffers ~1.1 s of PCM before
      // producing any output. Setting analyzeduration=0 reduces that to ~50 ms.
      const inputArgs = [
        ...this.buildLowLatencyArgs(),
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
            spawnToFirstInputMs: this.startTs ? Math.max(0, Date.now() - this.startTs) : null,
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
      restartOnFailure:
        (this.source.kind === 'url' && this.source.restartOnFailure === true) ||
        this.source.kind === 'pipe',
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
      const aligned = this.profile === 'pcm' ? this.alignPcmChunk(chunk) : chunk;
      if (!aligned?.length) {
        // Hold until we have a full PCM frame so new subscribers don't start mid-sample.
        this.recordBytes(chunk.length);
        this.maybeApplyOutputPacing();
        return;
      }
      if (!this.firstChunkLogged) {
        this.firstChunkLogged = true;
        if (this.firstChunkResolve) {
          this.firstChunkResolve(true);
          this.firstChunkResolve = null;
        }
        if (options.logFirstChunk !== false) {
          const now = Date.now();
          this.log.info('ffmpeg first chunk', {
            zoneId: this.zoneId,
            profile: this.profile,
            bytes: aligned.length,
            spawnToFirstChunkMs: this.startTs ? Math.max(0, now - this.startTs) : null,
          });
        }
        // Capture codec header from FLAC streams so new subscribers joining
        // mid-stream can initialize their decoders correctly.
        if (this.isCodecHeaderChunk(aligned)) {
          this.codecHeader = Buffer.from(aligned);
        }
      }
      this.bufferChunk(aligned);
      this.recordBytes(chunk.length);
      this.writeToSubscribers(aligned);
      this.maybeApplyOutputPacing();
    });

    proc.stdout.on('close', () => {
      this.log.debug('ffmpeg stdout closed', { zoneId: this.zoneId, profile: this.profile });
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
      // Treat very short runs as suspicious, but don't flag short finite files (e.g. alert MP3s)
      // just because they naturally produce <200KB of output.
      const smallOutputIsSuspicious =
        this.source.kind !== 'file' && this.totalBytes < 200 * 1024;
      const earlyExit = runMs !== null && (runMs < 1000 || smallOutputIsSuspicious);
      this.lastExitCode = typeof code === 'number' ? code : null;
      this.lastExitSignal = signal ?? null;
      this.log.info('ffmpeg exited', {
        zoneId: this.zoneId,
        profile: this.profile,
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
      const shouldRestartForEq = this.restartingForEq && !this.ending;
      const shouldRestart =
        !shouldRestartForEq && options.restartOnFailure === true && !this.ending && code !== 0;
      this.cleanup({ suppressTermination: shouldRestart || shouldRestartForEq });
      if (shouldRestartForEq) {
        this.restartingForEq = false;
        setTimeout(() => this.start(), 0);
        return;
      }
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

  // All three flags are required for truly low-latency pipe/stream sources:
  //   -fflags nobuffer      – disable ffmpeg's input read-ahead buffer
  //   -probesize 32k        – limit format probing to 32 KB (default 5 MB)
  //   -analyzeduration 0    – skip the stream analysis phase entirely
  // Even when the input format is explicitly specified with -f, ffmpeg still runs an
  // analyze phase that reads ~200 KB (~1.1 s of 44.1 kHz stereo PCM) before producing
  // any output. -fflags nobuffer alone does NOT suppress this — analyzeduration=0 is
  // required to reduce the startup delay to ~50 ms.
  private buildLowLatencyArgs(): string[] {
    return ['-fflags', 'nobuffer', '-probesize', '32k', '-analyzeduration', '0'];
  }

  private buildBufferedArgs(): string[] {
    return ['-probesize', '256k', '-analyzeduration', '1M'];
  }

  private pauseStdout(): void {
    if (this.stdoutPaused) {
      return;
    }
    if (this.directPipeMode && this.pipeSourceStream && typeof (this.pipeSourceStream as any).pause === 'function') {
      (this.pipeSourceStream as any).pause();
      this.stdoutPaused = true;
      return;
    }
    if (!this.process?.stdout) {
      return;
    }
    this.process.stdout.pause();
    this.stdoutPaused = true;
  }

  private resumeStdout(): void {
    if (!this.stdoutPaused || this.backpressureCount > 0) {
      return;
    }
    if (this.directPipeMode && this.pipeSourceStream && typeof (this.pipeSourceStream as any).resume === 'function') {
      (this.pipeSourceStream as any).resume();
      this.stdoutPaused = false;
      return;
    }
    if (!this.process?.stdout) {
      return;
    }
    this.process.stdout.resume();
    this.stdoutPaused = false;
  }

  private computePacingBps(): number | null {
    if (this.source.kind !== 'url') {
      return null;
    }
    // Only pace when -re has been explicitly disabled.
    if (this.source.realTime !== false) {
      return null;
    }
    const { sampleRate, channels, pcmBitDepth, mp3Bitrate } = this.outputSettings;
    switch (this.profile) {
      case 'mp3':
      case 'aac':
      case 'opus': {
        // Bitrate is stored as "k" bits/sec; convert to bytes/sec.
        const bytesPerSec = Math.round(mp3BitrateToBps(mp3Bitrate || '160k') / 8);
        return bytesPerSec > 0 ? bytesPerSec : null;
      }
      case 'pcm': {
        const bytesPerSec = Math.round(sampleRate * channels * (pcmBitDepth / 8));
        return bytesPerSec > 0 ? bytesPerSec : null;
      }
      case 'flac':
      default:
        return null;
    }
  }

  private clearPacingTimer(): void {
    if (this.pacingTimer) {
      clearTimeout(this.pacingTimer);
      this.pacingTimer = undefined;
    }
  }

  private maybeApplyOutputPacing(): void {
    if (!this.process?.stdout) return;
    if (!this.pacingBps || this.pacingBps <= 0) return;
    if (!this.startTs) return;
    if (this.backpressureCount > 0) return;
    if (this.pacingMaxAheadBytes <= 0) return;

    const now = Date.now();
    const elapsedMs = Math.max(0, now - this.startTs);
    const expectedBytes = (this.pacingBps * elapsedMs) / 1000;
    const allowedBytes = expectedBytes + this.pacingMaxAheadBytes;
    const overshoot = this.totalBytes - allowedBytes;

    if (overshoot > 0) {
      if (!this.pacingPaused) {
        this.pacingPaused = true;
        this.log.spam('ffmpeg output pacing pause', {
          zoneId: this.zoneId,
          profile: this.profile,
          overshootBytes: Math.round(overshoot),
          maxAheadBytes: this.pacingMaxAheadBytes,
          subscribers: this.subscribers.size,
        });
      }
      this.pauseStdout();

      // Resume when wall clock catches up. Keep the stream paused when no subscribers are present.
      const waitMs = Math.min(15_000, Math.max(5, Math.ceil((overshoot / this.pacingBps) * 1000)));
      if (!this.pacingTimer) {
        this.pacingTimer = setTimeout(() => {
          this.pacingTimer = undefined;
          if (this.subscribers.size === 0) {
            return;
          }
          this.pacingPaused = false;
          this.log.spam('ffmpeg output pacing resume', { zoneId: this.zoneId, profile: this.profile });
          this.resumeStdout();
        }, waitMs);
        this.pacingTimer.unref();
      }
      return;
    }

    if (this.pacingPaused && this.subscribers.size > 0) {
      this.pacingPaused = false;
      this.log.spam('ffmpeg output pacing resume', { zoneId: this.zoneId, profile: this.profile });
      this.clearPacingTimer();
      this.resumeStdout();
    }
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

  private bufferChunk(chunk: Buffer): void {
    if (this.maxBufferBytes <= 0 || !chunk?.length) {
      return;
    }

    if (this.keepInitialBuffer) {
      const remaining = this.maxBufferBytes - this.bufferBytes;
      if (remaining <= 0) {
        return;
      }
      const toStore = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      this.bufferQueue.push(toStore);
      this.bufferBytes += toStore.length;
      return;
    }

    if (chunk.length >= this.maxBufferBytes) {
      const tail = chunk.subarray(chunk.length - this.maxBufferBytes);
      this.bufferQueue.length = 0;
      this.bufferQueue.push(tail);
      this.bufferBytes = tail.length;
      return;
    }

    this.bufferQueue.push(chunk);
    this.bufferBytes += chunk.length;
    while (this.bufferBytes > this.maxBufferBytes && this.bufferQueue.length > 0) {
      const removed = this.bufferQueue.shift();
      if (!removed) {
        break;
      }
      this.bufferBytes -= removed.length;
    }
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
      // When URL input pacing is disabled (`realTime=false`), we rely on output backpressure to prevent
      // ffmpeg from running far ahead and exiting early on finite sources (e.g. Apple Music track MP4s).
      // That backpressure is computed using output bitrate; FLAC is variable so we can't pace it reliably
      // that way. For FLAC, force `-re` even when `realTime=false` to keep ffmpeg aligned with wall clock.
      const realtimeArgs =
        this.source.realTime === true || (this.source.realTime === false && this.profile === 'flac')
          ? ['-re']
          : [];
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
        ...this.buildLowLatencyArgs(),
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
        const delayMs = Math.max(0, Math.round(this.sourcePreDelayMs));
        filters.push(`adelay=delays=${delayMs}:all=1`);
      }
      if (this.sourcePadTailSec && this.sourcePadTailSec > 0) {
        filters.push(`apad=pad_dur=${this.sourcePadTailSec}`);
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

      // Apply built-in 10-band EQ at the output sample rate, after resampling.
      const eqChain = buildEqualizerFilterChain(this.equalizerBands);
      if (eqChain) {
        filters.push(eqChain);
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
          '0',
          '-frame_size',
          '512',
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

  /**
   * Replace the EQ bands and respawn ffmpeg without tearing down subscribers.
   *
   * The standard restart path (PlaybackService.start) does
   * stop({ discardSubscribers: true }), which destroys the output adapters'
   * PassThrough streams and stops audible playback until the user re-presses
   * Play. For an EQ change we want to keep those subscribers attached and
   * just swap the running ffmpeg process — there's an expected brief audio
   * hikje, but playback auto-resumes.
   *
   * Mechanism mirrors the existing internal restartOnFailure path: SIGTERM
   * the process, then in the exit handler call cleanup with
   * suppressTermination=true (preserves subscribers) and call start() again,
   * which spawns a fresh ffmpeg using the now-updated equalizerBands.
   */
  public restartForEqualizer(bands: ReadonlyArray<number> | null): void {
    this.equalizerBands = bands;
    if (!this.process) {
      // No ffmpeg running yet; the next start() will pick up the new bands.
      return;
    }
    if (this.ending || this.restartingForEq) {
      return;
    }
    this.restartingForEq = true;
    this.process.kill('SIGTERM');
    this.armKillTimer();
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

  public hasFirstChunk(): boolean {
    return this.firstChunkLogged;
  }

  public createSubscriber(options: { primeWithBuffer?: boolean; label?: string } = {}): PassThrough | null {
    if (!this.process && !this.directPipeMode) {
      return null;
    }
    const stream = new PassThrough({ highWaterMark: 1024 * 512 });
    let primedBytes = 0;
    const primeWithBuffer = options.primeWithBuffer !== false;
    const codecHeader = this.codecHeader;
    // For codec streams (FLAC), prepend the saved header so the subscriber's
    // decoder can initialize correctly even when joining mid-stream.
    if (codecHeader && (!primeWithBuffer || !this.bufferedChunkStartsWithCodecHeader())) {
      stream.write(codecHeader);
      primedBytes += codecHeader.length;
    }
    // Prime the subscriber with buffered audio to prevent initial starvation unless disabled.
    if (primeWithBuffer && this.bufferQueue.length) {
      for (const chunk of this.bufferQueue) {
        stream.write(chunk);
        primedBytes += chunk.length;
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
      primeWithBuffer,
      primedBytes,
      primedMs:
        this.profile === 'pcm' &&
        this.outputSettings.sampleRate > 0 &&
        this.outputSettings.channels > 0 &&
        this.outputSettings.pcmBitDepth > 0
          ? Math.round(
              (primedBytes /
                (this.outputSettings.sampleRate *
                  this.outputSettings.channels *
                  (this.outputSettings.pcmBitDepth / 8))) *
                1000,
            )
          : null,
      sessionBufferedBytes: this.bufferBytes,
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
    this.clearPacingTimer();
    this.detachPipeSourceListeners();
    this.directPipeMode = false;
    if (suppressTermination && this.firstChunkResolve) {
      // ffmpeg is restarting; chain existing waiters to the next promise so the position
      // ticker does not start prematurely before the restarted process produces output.
      this.chainedFirstChunkResolve = this.firstChunkResolve;
    } else if (this.firstChunkResolve) {
      this.firstChunkResolve(false);
    }
    this.firstChunkResolve = null;
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
    this.pacingPaused = false;
    // When suppressTermination is true, ffmpeg is restarting internally (restartOnFailure).
    // Keep subscribers alive so the sync stream and downstream clients (e.g. Squeezelite)
    // stay connected and receive audio from the new ffmpeg process without interruption.
    if (!suppressTermination) {
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
      this.subscribers.clear();
      this.discardSubscribersOnStop = false;
    }
    if (this.debugTapStream) {
      try {
        this.debugTapStream.end();
      } catch {
        /* ignore */
      }
      this.debugTapStream = undefined;
    }
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
