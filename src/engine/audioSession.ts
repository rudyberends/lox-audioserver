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
    }
;

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
  private pipeSourceErrorListener?: (err: unknown) => void;
  private pipeSourceEndListener?: () => void;
  private directPipeMode = false;
  // Two-stage PCM pipeline (decoder → pcmPipe → encoderInput → encoder)
  private decoderProc?: ChildProcessWithoutNullStreams;
  private pcmPipe?: PassThrough;
  private encoderInput?: PassThrough; // permanent bridge to encoder stdin
  private crossfadeActive = false;
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
    this.sourcePreDelayMs =
      'preDelayMs' in this.source && typeof this.source.preDelayMs === 'number'
        ? this.source.preDelayMs
        : undefined;
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

  private extractFlacMetadataLength(data: Buffer): number {
    // Return only the STREAMINFO block (always the first block, always 34 bytes of data).
    // STREAMINFO is the only block VLC needs to initialize the decoder.
    // Optional blocks (PADDING, SEEKTABLE, VORBIS_COMMENT) can be very large
    // and are not needed for decoding — sending them as a burst inflates VLC's
    // network-cache estimate.
    if (data.length < 8) return data.length;
    const firstBlockDataLen = (data[5]! << 16) | (data[6]! << 8) | data[7]!;
    return Math.min(4 + 4 + firstBlockDataLen, data.length); // fLaC + block-header + STREAMINFO
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
        this.pipeSourceErrorListener = (err: unknown) => {
          this.log.warn('pipe source error', {
            zoneId: this.zoneId,
            message: (err as { message?: string } | null)?.message || String(err),
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
      // Insert PassThrough chain so crossfade can blend PCM before the encoder.
      // pipeSource.stream → pcmPipe → encoderInput → FFmpeg.stdin
      const pcmBridge = new PassThrough();
      const encInput = new PassThrough();
      this.pcmPipe = pcmBridge;
      this.encoderInput = encInput;
      this.pipeSourceStream = pipeSource.stream;
      pipeSource.stream.pipe(pcmBridge, { end: false });
      pcmBridge.pipe(encInput, { end: false });

      const onSourceEnd = () => {
        try { pipeSource.stream.unpipe(pcmBridge); } catch { /* ignore */ }
        if (!this.crossfadeActive && !this.ending) encInput.end();
      };
      pipeSource.stream.once('end', onSourceEnd);
      pipeSource.stream.once('close', onSourceEnd);
      this.pipeSourceEndListener = onSourceEnd;

      this.pipeSourceErrorListener = (err: unknown) => {
        this.log.warn('pipe source error', {
          zoneId: this.zoneId,
          message: err instanceof Error ? err.message : String(err),
        });
        encInput.destroy();
      };
      pipeSource.stream.on('error', this.pipeSourceErrorListener);

      this.startTs = Date.now();
      let proc: ChildProcessWithoutNullStreams;
      proc = this.spawnFfmpeg(args, {
        restartOnFailure: false,
        logFirstChunk: false,
        onExit: () => {
          try { encInput.unpipe(proc.stdin); } catch { /* ignore */ }
        },
      });
      encInput.pipe(proc.stdin);
      proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (err?.code === 'EPIPE') {
          this.log.debug('ffmpeg stdin closed (EPIPE)', { zoneId: this.zoneId });
        } else {
          this.log.warn('ffmpeg stdin error', {
            zoneId: this.zoneId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
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

    // File and URL sources use the two-stage PCM pipeline so crossfade can be
    // performed by blending raw PCM without switching the HTTP stream.
    if (this.source.kind === 'file' || this.source.kind === 'url') {
      this.startTwoStage();
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
      // After the file/url guard above, only pipe/crossfade sources reach here.
      restartOnFailure: this.source.kind === 'pipe',
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
      this.pipeSourceErrorListener = (err: unknown) => {
        this.log.warn('pipe source error', {
          zoneId: this.zoneId,
          message: (err as { message?: string } | null)?.message || String(err),
        });
        proc.stdin.destroy();
      };
      options.stdinStream.on('error', this.pipeSourceErrorListener);
      proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
        const e = err as { code?: string; message?: string } | null;
        if (e?.code === 'EPIPE') {
          this.log.debug('ffmpeg stdin closed (EPIPE)', { zoneId: this.zoneId });
        } else {
          this.log.warn('ffmpeg stdin error', {
            zoneId: this.zoneId,
            message: e?.message || String(err),
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
        // Capture only the FLAC STREAMINFO block as the codec header.
        // Sending the full first chunk (64 KB) as a burst causes VLC's adaptive
        // network-cache to inflate its buffer to 30+ seconds before playback starts.
        // STREAMINFO alone (42 bytes) is sufficient for the decoder to initialise.
        if (this.isCodecHeaderChunk(aligned)) {
          const metaLen = this.extractFlacMetadataLength(aligned);
          const header = Buffer.from(aligned.subarray(0, metaLen));
          // Set is_last on the STREAMINFO block so VLC knows audio frames follow immediately.
          if (header.length >= 5) {
            header[4] = (header[4]! & 0x7f) | 0x80;
          }
          this.codecHeader = header;
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

  /**
   * PCM crossfade — works for any source that uses the two-stage pipeline.
   *
   * The running decoder (old track) continues naturally; a new decoder is spawned
   * for the fade-in source. Both PCM streams are blended frame-by-frame in Node.js
   * with a linear volume ramp and written directly to encoderInput (which stays
   * connected to the encoder FFmpeg throughout). Squeezelite never reconnects.
   */
  public async inlineCrossfade(
    fadeIn:
      | { kind: 'file'; path: string }
      | { kind: 'url'; url: string; headers?: Record<string, string>; decryptionKey?: string }
      | { kind: 'pipe'; stream: NodeJS.ReadableStream; sampleRate: number; channels: number },
    durationSec: number,
  ): Promise<boolean> {
    if (this.directPipeMode && this.pipeSourceStream) {
      return this.inlineCrossfadeFromDirectPipe(fadeIn, durationSec);
    }
    if (this.pipeSourceStream && this.pcmPipe && this.encoderInput && !this.decoderProc) {
      return this.inlineCrossfadeFromPipeFFmpeg(fadeIn, durationSec);
    }
    if (!this.pcmPipe || !this.encoderInput || !this.decoderProc) return false;
    if (fadeIn.kind === 'pipe') return false; // pipe fade-in requires pipe fade-out path

    const { sampleRate } = this.outputSettings;
    const totalFrames = Math.round(durationSec * sampleRate);

    // Spawn new decoder for the incoming track.
    const newDecoderArgs = this.buildPcmDecoderArgsForSource(fadeIn);
    const newDecoder = spawn(this.ffmpegPath, newDecoderArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    newDecoder.stderr?.on('data', (c: Buffer) => {
      const msg = c.toString().trim();
      if (msg) this.log.debug('new decoder stderr', { zoneId: this.zoneId, message: msg });
    });

    this.crossfadeActive = true;
    const oldDecoder = this.decoderProc as ChildProcessWithoutNullStreams;

    this.log.info('PCM crossfade blend starting', {
      zoneId: this.zoneId,
      durationSec,
      totalFrames,
    });
    // If the encoder's stdout was paused (subscriber count dropped to 0 mid-song),
    // resume it now so the blend loop can write PCM without hitting backpressure.
    if (this.stdoutPaused) {
      this.resumeStdout();
    }

    // Keep decoder→pcmPipe intact (avoids OS-pipe stall from unpipe+resume).
    // Only disconnect pcmPipe→encoderInput so we can write blended PCM directly.
    this.pcmPipe!.unpipe(this.encoderInput);

    // Collect old PCM from pcmPipe (decoder still writes to it as normal).
    // Collect new PCM from the freshly-spawned decoder's stdout.
    const oldChunks: Buffer[] = [];
    const newChunks: Buffer[] = [];
    let oldEnded = false;
    let newEnded = false;

    this.pcmPipe!.on('data', (c: Buffer) => oldChunks.push(c));
    // decoder→pcmPipe uses { end: false }, so pcmPipe never emits 'end' when the
    // decoder exits. Watch the decoder process exit directly instead.
    const onOldDecoderExit = () => { oldEnded = true; };
    oldDecoder.once('exit', onOldDecoderExit);
    // Explicitly resume the backpressure chain: unpiping from encoderInput may have
    // left pcmPipe and decoder.stdout in a paused state. Resume both to restart flow.
    this.pcmPipe!.resume();
    oldDecoder.stdout.resume();
    newDecoder.stdout.on('data', (c: Buffer) => newChunks.push(c));
    newDecoder.stdout.on('end', () => { newEnded = true; });

    // Use a fixed-interval timer rather than a recursive setTimeout/drain chain.
    // The drain-based approach silently stalls when the encoder's stdout is paused
    // (e.g., subscriber briefly disconnected). setInterval always fires regardless
    // of downstream backpressure; we intentionally ignore write backpressure here
    // since the PCM trickles in at real-time rate (~1.76 KB per 10 ms tick).
    const { framesProcessed, newRem } = await this.runPcmBlend(
      oldChunks, newChunks, totalFrames,
      () => oldEnded, () => newEnded,
      (blended) => { this.encoderInput?.write(blended); },
    );

    // Crossfade complete — transition to new decoder only.
    this.crossfadeActive = false;
    // Remove all exit/error listeners before killing so the old decoder's exit does
    // NOT call encoderInput.end() (which would prematurely terminate the encoder).
    oldDecoder.off('exit', onOldDecoderExit);
    oldDecoder.removeAllListeners('exit');
    oldDecoder.removeAllListeners('error');
    this.pcmPipe!.removeAllListeners('data');
    // Disconnect old decoder from old pcmPipe, then kill it.
    oldDecoder.stdout.unpipe(this.pcmPipe!);
    oldDecoder.kill('SIGTERM');

    // Write any leftover new-decoder PCM buffered during blend.
    if (newRem.length) this.encoderInput!.write(newRem);
    newDecoder.stdout.removeAllListeners('data');
    newDecoder.stdout.removeAllListeners('end');

    // Reconnect: newDecoder → fresh pcmPipe → encoderInput.
    const newPcmPipe = new PassThrough();
    this.pcmPipe = newPcmPipe;
    this.decoderProc = newDecoder;

    newDecoder.stdout.pipe(newPcmPipe, { end: false });
    newPcmPipe.pipe(this.encoderInput!, { end: false });

    newDecoder.on('exit', (code, signal) => {
      this.log.debug('new decoder exited (after crossfade)', { zoneId: this.zoneId, code, signal });
      if (!this.crossfadeActive) this.encoderInput?.end();
    });
    newDecoder.on('error', (err: NodeJS.ErrnoException) => {
      this.log.warn('new decoder error', { zoneId: this.zoneId, message: err.message });
    });

    this.log.info('PCM crossfade complete', {
      zoneId: this.zoneId, framesProcessed, totalFrames, durationSec,
    });
    return true;
  }

  /**
   * Shared PCM blend loop — collects PCM from oldChunks/newChunks arrays (filled by
   * concurrent data-event listeners) and calls onBlendedFrame every 10 ms with the
   * linearly cross-faded result. Returns framesProcessed and any leftover new PCM.
   *
   * Stall handling: a Spotify pipe-source PassThrough never fires `'end'` when the
   * track ends — librespot just stops writing. If we waited for `*Ended` we would
   * spin forever (which previously caused the blend to hang for minutes and
   * orphan the whole audio session). When one source has been silent longer than
   * STALL_MS *after producing at least one chunk* we treat its samples as silence
   * so the linear ramp keeps running and the blend completes within `totalFrames`.
   *
   * Sources that have never produced data get a separate STARTUP_TIMEOUT_MS budget
   * (librespot needs ~600 ms before its first PCM chunk arrives). Without this we
   * would bail at framesProcessed=0 whenever the OLD librespot was already stalled
   * before the trigger fired (e.g., a 4 s pcm_stall right before song-end).
   */
  private async runPcmBlend(
    oldChunks: Buffer[],
    newChunks: Buffer[],
    totalFrames: number,
    getOldEnded: () => boolean,
    getNewEnded: () => boolean,
    onBlendedFrame: (blended: Buffer) => void,
  ): Promise<{ framesProcessed: number; newRem: Buffer }> {
    const { channels } = this.outputSettings;
    const frameBytes = channels * 2;
    let framesProcessed = 0;
    let oldRem = Buffer.alloc(0);
    let newRem = Buffer.alloc(0);
    const STALL_MS = 300;
    const STARTUP_TIMEOUT_MS = 1500;
    const startTs = Date.now();
    let oldLastDataAt = startTs;
    let newLastDataAt = startTs;
    let oldHasProduced = false;
    let newHasProduced = false;
    let oldStallLogged = false;
    let newStallLogged = false;

    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const now = Date.now();
        if (oldChunks.length) {
          oldRem = Buffer.concat([oldRem, ...oldChunks.splice(0)]);
          oldLastDataAt = now;
          oldHasProduced = true;
        }
        if (newChunks.length) {
          newRem = Buffer.concat([newRem, ...newChunks.splice(0)]);
          newLastDataAt = now;
          newHasProduced = true;
        }

        const elapsedMs = now - startTs;
        const oldStalledAfterProducing =
          oldHasProduced && oldRem.length < frameBytes && now - oldLastDataAt > STALL_MS;
        const oldNeverStarted = !oldHasProduced && elapsedMs > STARTUP_TIMEOUT_MS;
        const oldEffectivelyDone = getOldEnded() || oldStalledAfterProducing || oldNeverStarted;

        const newStalledAfterProducing =
          newHasProduced && newRem.length < frameBytes && now - newLastDataAt > STALL_MS;
        const newNeverStarted = !newHasProduced && elapsedMs > STARTUP_TIMEOUT_MS;
        const newEffectivelyDone = getNewEnded() || newStalledAfterProducing || newNeverStarted;

        if (oldEffectivelyDone && !oldStallLogged) {
          oldStallLogged = true;
          this.log.debug('PCM crossfade old source stalled — using silence for remaining blend', {
            zoneId: this.zoneId, framesProcessed, totalFrames,
            oldEnded: getOldEnded(), oldHasProduced, elapsedMs,
          });
        }
        if (newEffectivelyDone && !newStallLogged) {
          newStallLogged = true;
          this.log.debug('PCM crossfade new source stalled — using silence for remaining blend', {
            zoneId: this.zoneId, framesProcessed, totalFrames,
            newEnded: getNewEnded(), newHasProduced, elapsedMs,
          });
        }

        if (oldEffectivelyDone && newEffectivelyDone) {
          this.log.warn('PCM crossfade blend ended early', {
            zoneId: this.zoneId, framesProcessed, totalFrames,
            oldEnded: getOldEnded(), newEnded: getNewEnded(),
            oldHasProduced, newHasProduced, elapsedMs,
          });
          clearInterval(timer);
          resolve();
          return;
        }

        // Bound how many frames to process this tick so we never write a multi-second
        // burst to the encoder when one side stalls and the other has buffered ahead.
        const remainingFrames = totalFrames - framesProcessed;
        const oldAvailFrames = oldEffectivelyDone ? remainingFrames : Math.floor(oldRem.length / frameBytes);
        const newAvailFrames = newEffectivelyDone ? remainingFrames : Math.floor(newRem.length / frameBytes);
        const framesThisTick = Math.min(oldAvailFrames, newAvailFrames, remainingFrames);
        if (framesThisTick <= 0) {
          return;
        }

        const blended = Buffer.alloc(framesThisTick * frameBytes);
        let oldOff = 0;
        let newOff = 0;
        for (let f = 0; f < framesThisTick; f++) {
          const t = Math.min(1, framesProcessed / totalFrames);
          const dstOff = f * frameBytes;
          for (let ch = 0; ch < channels; ch++) {
            const co = ch * 2;
            const a = oldEffectivelyDone ? 0 : oldRem.readInt16LE(oldOff + co);
            const b = newEffectivelyDone ? 0 : newRem.readInt16LE(newOff + co);
            blended.writeInt16LE(
              Math.max(-32768, Math.min(32767, Math.round(a * (1 - t) + b * t))),
              dstOff + co,
            );
          }
          if (!oldEffectivelyDone) oldOff += frameBytes;
          if (!newEffectivelyDone) newOff += frameBytes;
          framesProcessed++;
        }
        if (!oldEffectivelyDone) oldRem = oldRem.subarray(oldOff);
        if (!newEffectivelyDone) newRem = newRem.subarray(newOff);
        onBlendedFrame(blended);

        if (framesProcessed >= totalFrames) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });

    return { framesProcessed, newRem };
  }

  /**
   * PCM crossfade for pipe sources in FFmpeg mode (pipeSource → pcmPipe → encoderInput → FFmpeg).
   * Supports file/URL (spawns a decoder) and pipe (uses stream directly) as fade-in.
   */
  private async inlineCrossfadeFromPipeFFmpeg(
    fadeIn:
      | { kind: 'file'; path: string }
      | { kind: 'url'; url: string; headers?: Record<string, string>; decryptionKey?: string }
      | { kind: 'pipe'; stream: NodeJS.ReadableStream; sampleRate: number; channels: number },
    durationSec: number,
  ): Promise<boolean> {
    if (!this.pcmPipe || !this.encoderInput || !this.pipeSourceStream) return false;

    const { sampleRate } = this.outputSettings;
    const totalFrames = Math.round(durationSec * sampleRate);

    // New source: either a decoder process (file/url) or a live pipe stream (Spotify-to-Spotify).
    let newSourceStream: NodeJS.ReadableStream;
    let newDecoder: ChildProcessWithoutNullStreams | undefined;
    if (fadeIn.kind === 'pipe') {
      newSourceStream = fadeIn.stream;
    } else {
      newDecoder = spawn(this.ffmpegPath, this.buildPcmDecoderArgsForSource(fadeIn), {
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
      newDecoder.stderr?.on('data', (c: Buffer) => {
        const msg = c.toString().trim();
        if (msg) this.log.debug('new decoder stderr', { zoneId: this.zoneId, message: msg });
      });
      newSourceStream = newDecoder.stdout;
    }

    this.crossfadeActive = true;

    this.log.info('PCM crossfade blend starting (pipe-ffmpeg)', {
      zoneId: this.zoneId, durationSec, totalFrames, fadeInKind: fadeIn.kind,
    });
    if (this.stdoutPaused) this.resumeStdout();

    this.pcmPipe.unpipe(this.encoderInput);

    const oldChunks: Buffer[] = [];
    const newChunks: Buffer[] = [];
    let oldEnded = false;
    let newEnded = false;

    this.pcmPipe.on('data', (c: Buffer) => oldChunks.push(c));
    const onOldEnd = () => { oldEnded = true; };
    this.pipeSourceStream.once('end', onOldEnd);
    this.pcmPipe.resume();

    newSourceStream.on('data', (c: Buffer) => newChunks.push(c));
    newSourceStream.once('end', () => { newEnded = true; });

    const { framesProcessed, newRem } = await this.runPcmBlend(
      oldChunks, newChunks, totalFrames,
      () => oldEnded, () => newEnded,
      (blended) => this.encoderInput?.write(blended),
    );

    this.crossfadeActive = false;

    this.pipeSourceStream.off('end', onOldEnd);
    this.pcmPipe.removeAllListeners('data');
    try { this.pipeSourceStream.unpipe(this.pcmPipe); } catch { /* ignore */ }
    this.detachPipeSourceListeners();

    if (newRem.length) this.encoderInput!.write(newRem);
    newSourceStream.removeAllListeners('data');
    newSourceStream.removeAllListeners('end');

    const newPcmPipe = new PassThrough();
    this.pcmPipe = newPcmPipe;

    if (fadeIn.kind === 'pipe') {
      // Pipe fade-in: wire the new Spotify stream as the new pcmPipe source.
      this.pipeSourceStream = fadeIn.stream;
      fadeIn.stream.pipe(newPcmPipe, { end: false });
      newPcmPipe.pipe(this.encoderInput!, { end: false });
      const onEnd = () => {
        if (!this.crossfadeActive && !this.ending) this.encoderInput?.end();
      };
      fadeIn.stream.once('end', onEnd);
      fadeIn.stream.once('close', onEnd);
      this.pipeSourceEndListener = onEnd;
      this.pipeSourceErrorListener = (err: unknown) => {
        this.log.warn('crossfade pipe stream error', { zoneId: this.zoneId, message: err instanceof Error ? err.message : String(err) });
        if (!this.crossfadeActive && !this.ending) this.encoderInput?.end();
      };
      fadeIn.stream.on('error', this.pipeSourceErrorListener);
    } else {
      // Decoder fade-in: wire the decoder as the new decoderProc.
      this.decoderProc = newDecoder!;
      newDecoder!.stdout.pipe(newPcmPipe, { end: false });
      newPcmPipe.pipe(this.encoderInput!, { end: false });
      newDecoder!.on('exit', (code, signal) => {
        this.log.debug('new decoder exited (after pipe-ffmpeg crossfade)', { zoneId: this.zoneId, code, signal });
        if (!this.crossfadeActive) this.encoderInput?.end();
      });
      newDecoder!.on('error', (err: NodeJS.ErrnoException) => {
        this.log.warn('new decoder error', { zoneId: this.zoneId, message: err.message });
      });
    }

    this.log.info('PCM crossfade complete (pipe-ffmpeg)', {
      zoneId: this.zoneId, framesProcessed, totalFrames, durationSec,
    });
    return true;
  }

  /**
   * PCM crossfade for pipe sources in direct-passthrough mode (profile=pcm, no FFmpeg).
   * Supports file/URL (spawns a decoder) and pipe (Spotify stream) as fade-in.
   * Blended PCM is written directly to subscribers. Afterwards a pseudo-two-stage pipeline
   * is wired so future crossfades on the new track work normally.
   */
  private async inlineCrossfadeFromDirectPipe(
    fadeIn:
      | { kind: 'file'; path: string }
      | { kind: 'url'; url: string; headers?: Record<string, string>; decryptionKey?: string }
      | { kind: 'pipe'; stream: NodeJS.ReadableStream; sampleRate: number; channels: number },
    durationSec: number,
  ): Promise<boolean> {
    if (!this.directPipeMode || !this.pipeSourceStream) return false;

    const { sampleRate } = this.outputSettings;
    const totalFrames = Math.round(durationSec * sampleRate);

    let newSourceStream: NodeJS.ReadableStream;
    let newDecoder: ChildProcessWithoutNullStreams | undefined;
    if (fadeIn.kind === 'pipe') {
      newSourceStream = fadeIn.stream;
    } else {
      newDecoder = spawn(this.ffmpegPath, this.buildPcmDecoderArgsForSource(fadeIn), {
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
      newDecoder.stderr?.on('data', (c: Buffer) => {
        const msg = c.toString().trim();
        if (msg) this.log.debug('new decoder stderr', { zoneId: this.zoneId, message: msg });
      });
      newSourceStream = newDecoder.stdout;
    }

    this.crossfadeActive = true;
    const oldStream = this.pipeSourceStream;

    this.log.info('PCM crossfade blend starting (direct-pipe)', {
      zoneId: this.zoneId, durationSec, totalFrames, fadeInKind: fadeIn.kind,
    });
    if (this.stdoutPaused) this.resumeStdout();

    if (this.pipeSourceDataListener) {
      oldStream.off('data', this.pipeSourceDataListener);
      this.pipeSourceDataListener = undefined;
    }

    const oldChunks: Buffer[] = [];
    const newChunks: Buffer[] = [];
    let oldEnded = false;
    let newEnded = false;

    const onOldData = (c: Buffer) => oldChunks.push(c);
    const onOldEnd = () => { oldEnded = true; };
    oldStream.on('data', onOldData);
    oldStream.once('end', onOldEnd);
    oldStream.resume();

    newSourceStream.on('data', (c: Buffer) => newChunks.push(c));
    newSourceStream.once('end', () => { newEnded = true; });

    const { framesProcessed, newRem } = await this.runPcmBlend(
      oldChunks, newChunks, totalFrames,
      () => oldEnded, () => newEnded,
      (blended) => {
        this.bufferChunk(blended);
        this.writeToSubscribers(blended);
      },
    );

    this.crossfadeActive = false;
    this.directPipeMode = false;

    oldStream.off('data', onOldData);
    oldStream.off('end', onOldEnd);
    this.pipeSourceStream = undefined;

    if (newRem.length) {
      this.bufferChunk(newRem);
      this.writeToSubscribers(newRem);
    }
    newSourceStream.removeAllListeners('data');
    newSourceStream.removeAllListeners('end');

    // Wire a pseudo-two-stage pipeline so future inlineCrossfade calls work on the new track.
    const newPcmPipe = new PassThrough();
    const newEncoderInput = new PassThrough();
    this.pcmPipe = newPcmPipe;
    this.encoderInput = newEncoderInput;

    newEncoderInput.on('data', (chunk: Buffer) => {
      const aligned = this.alignPcmChunk(chunk);
      if (aligned?.length) {
        this.bufferChunk(aligned);
        this.writeToSubscribers(aligned);
      }
    });
    newEncoderInput.on('end', () => {
      if (!this.crossfadeActive && !this.ending) this.cleanup();
    });

    if (fadeIn.kind === 'pipe') {
      this.pipeSourceStream = fadeIn.stream;
      fadeIn.stream.pipe(newPcmPipe, { end: false });
      newPcmPipe.pipe(newEncoderInput, { end: false });
      const onEnd = () => {
        if (!this.crossfadeActive && !this.ending) newEncoderInput.end();
      };
      fadeIn.stream.once('end', onEnd);
      fadeIn.stream.once('close', onEnd);
      this.pipeSourceEndListener = onEnd;
      this.pipeSourceErrorListener = (err: unknown) => {
        this.log.warn('crossfade pipe stream error', { zoneId: this.zoneId, message: err instanceof Error ? err.message : String(err) });
        if (!this.crossfadeActive && !this.ending) newEncoderInput.end();
      };
      fadeIn.stream.on('error', this.pipeSourceErrorListener);
    } else {
      this.decoderProc = newDecoder!;
      newDecoder!.stdout.pipe(newPcmPipe, { end: false });
      newPcmPipe.pipe(newEncoderInput, { end: false });
      newDecoder!.on('exit', (code, signal) => {
        this.log.debug('new decoder exited (after direct-pipe crossfade)', { zoneId: this.zoneId, code, signal });
        if (!this.crossfadeActive) newEncoderInput.end();
      });
      newDecoder!.on('error', (err: NodeJS.ErrnoException) => {
        this.log.warn('new decoder error', { zoneId: this.zoneId, message: err.message });
      });
    }

    this.log.info('PCM crossfade complete (direct-pipe)', {
      zoneId: this.zoneId, framesProcessed, totalFrames, durationSec,
    });
    return true;
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
    // Never pause the encoder during an active PCM crossfade blend — the blend loop
    // writes directly to encoderInput and must not be blocked by subscriber backpressure.
    if (this.crossfadeActive) {
      return;
    }
    if (this.stdoutPaused) {
      return;
    }
    if (this.directPipeMode && this.pipeSourceStream && typeof this.pipeSourceStream.pause === 'function') {
      this.pipeSourceStream.pause();
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
    if (this.directPipeMode && this.pipeSourceStream && typeof this.pipeSourceStream.resume === 'function') {
      this.pipeSourceStream.resume();
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

  // ─── Two-stage PCM pipeline ────────────────────────────────────────────────

  /** Args for decoder FFmpeg: source → PCM s16le at target sample-rate/channels. */
  private buildPcmDecoderArgs(): string[] {
    const { sampleRate, channels } = this.outputSettings;
    const pcmOut = [
      '-vn', '-acodec', 'pcm_s16le',
      '-ar', String(sampleRate), '-ac', String(channels),
      '-f', 's16le', 'pipe:1',
    ];
    const log = ['-hide_banner', '-loglevel', this.getLogLevel()];

    if (this.source.kind === 'file') {
      const loopArgs = this.source.loop ? ['-stream_loop', '-1'] : [];
      const latencyArgs = this.isAlertSource ? this.buildBufferedArgs() : this.buildLowLatencyArgs();
      const realTimeArgs = this.source.realTime !== false ? ['-re'] : [];
      const seekArgs = this.buildSeekArgs(this.source.startAtSec);
      return [...log, ...latencyArgs, ...loopArgs, ...realTimeArgs, ...seekArgs, '-i', this.source.path, ...pcmOut];
    }

    if (this.source.kind === 'url') {
      const lowLatency = this.source.lowLatency !== false;
      const headerLines = this.source.headers ? this.formatHeaders(this.source.headers) : '';
      const headerArgs = headerLines ? ['-headers', headerLines] : [];
      const decryptionArgs = this.source.decryptionKey ? ['-decryption_key', this.source.decryptionKey] : [];
      const needsTls = Boolean(this.source.tlsVerifyHost && /^https:/i.test(this.source.url));
      const tlsArgs = needsTls ? ['-tls_verify', '0', '-verifyhost', this.source.tlsVerifyHost!] : [];
      const inputFormatArgs = this.source.inputFormat ? ['-f', this.source.inputFormat] : [];
      const realTimeArgs = this.source.realTime !== false ? ['-re'] : [];
      const seekArgs = this.buildSeekArgs(this.source.startAtSec);
      return [
        ...log,
        ...(lowLatency ? this.buildLowLatencyArgs() : this.buildBufferedArgs()),
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        ...tlsArgs, ...decryptionArgs, ...headerArgs, ...inputFormatArgs,
        ...realTimeArgs, ...seekArgs, '-i', this.source.url,
        ...pcmOut,
      ];
    }

    return [];
  }

  /** Args for decoder FFmpeg for an arbitrary fade-in source (used during crossfade). */
  private buildPcmDecoderArgsForSource(
    source: { kind: 'file'; path: string } | { kind: 'url'; url: string; headers?: Record<string, string>; decryptionKey?: string },
  ): string[] {
    const { sampleRate, channels } = this.outputSettings;
    const pcmOut = ['-vn', '-acodec', 'pcm_s16le', '-ar', String(sampleRate), '-ac', String(channels), '-f', 's16le', 'pipe:1'];
    const log = ['-hide_banner', '-loglevel', this.getLogLevel()];

    if (source.kind === 'file') {
      return [...log, ...this.buildLowLatencyArgs(), '-re', '-i', source.path, ...pcmOut];
    }

    const headerLines = source.headers ? this.formatHeaders(source.headers) : '';
    const headerArgs = headerLines ? ['-headers', headerLines] : [];
    const decryptionArgs = source.decryptionKey ? ['-decryption_key', source.decryptionKey] : [];
    return [
      ...log, ...this.buildLowLatencyArgs(),
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      ...decryptionArgs, ...headerArgs, '-re', '-i', source.url,
      ...pcmOut,
    ];
  }

  /** Args for encoder FFmpeg: PCM s16le from stdin → output profile. */
  private buildPcmEncoderArgs(): string[] {
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
        return [...base, '-acodec', 'aac', '-ar', String(sampleRate), '-ac', String(channels), '-b:a', br, '-f', 'adts', 'pipe:1'];
      }
      case 'pcm': {
        const codec = pcmCodecFromBitDepth(pcmBitDepth);
        const fmt = pcmFormatFromBitDepth(pcmBitDepth);
        return [...base, '-acodec', codec, '-ar', String(sampleRate), '-ac', String(channels), '-f', fmt, 'pipe:1'];
      }
      case 'opus': {
        const br = mp3Bitrate || '160k';
        return [...base, '-acodec', 'libopus', '-application', 'audio', '-b:a', br,
          '-ar', String(sampleRate), '-ac', String(channels), '-f', 'opus', 'pipe:1'];
      }
      case 'mp3':
      default: {
        const br = mp3Bitrate || '320k';
        return [...base, '-acodec', 'libmp3lame', '-ar', String(sampleRate), '-ac', String(channels), '-b:a', br, '-f', 'mp3', 'pipe:1'];
      }
    }
  }

  /**
   * Starts the session as a two-stage PCM pipeline:
   *   Decoder FFmpeg (source → s16le PCM) → pcmPipe → encoderInput → Encoder FFmpeg (PCM → output)
   *
   * The encoderInput PassThrough is a stable bridge to the encoder stdin. Replacing pcmPipe
   * (during crossfade) does not disconnect the encoder, so Squeezelite never reconnects.
   */
  private startTwoStage(): void {
    this.encoderInput = new PassThrough();
    this.pcmPipe = new PassThrough();
    this.startTs = Date.now();

    // ── Decoder ──────────────────────────────────────────────────────────────
    const decoderArgs = this.buildPcmDecoderArgs();
    this.log.debug('spawning ffmpeg (decoder)', { zoneId: this.zoneId, args: decoderArgs, profile: this.profile });

    const decoderProc = spawn(this.ffmpegPath, decoderArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.decoderProc = decoderProc;

    decoderProc.stdout.pipe(this.pcmPipe, { end: false });
    this.pcmPipe.pipe(this.encoderInput, { end: false });

    decoderProc.stderr?.on('data', (c: Buffer) => {
      const msg = c.toString().trim();
      if (msg) this.log.debug('decoder stderr', { zoneId: this.zoneId, message: msg });
    });

    decoderProc.on('exit', (code, signal) => {
      this.log.debug('decoder exited', { zoneId: this.zoneId, code, signal });
      if (!this.crossfadeActive) {
        this.encoderInput?.end();
      }
    });

    decoderProc.on('error', (err: NodeJS.ErrnoException) => {
      this.log.warn('decoder error', { zoneId: this.zoneId, message: err.message });
      if (!this.crossfadeActive) this.encoderInput?.end();
    });

    // ── Encoder ──────────────────────────────────────────────────────────────
    const encoderArgs = this.buildPcmEncoderArgs();
    this.log.debug('spawning ffmpeg (encoder)', { zoneId: this.zoneId, args: encoderArgs, profile: this.profile });

    const encoderProc = this.spawnFfmpeg(encoderArgs, {
      logFirstChunk: true,
      stdinStream: this.encoderInput,
    });
    this.process = encoderProc;
    this.restartAttempts = 0;
  }

  // ─── (end two-stage) ───────────────────────────────────────────────────────

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
    // In two-stage mode also kill the decoder; the encoder (this.process) is killed below.
    if (this.decoderProc) {
      this.decoderProc.stdout.removeAllListeners();
      this.decoderProc.kill('SIGTERM');
      this.decoderProc = undefined;
    }
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
        const pending = (subscriber as { _writableState?: { length?: number } })?._writableState?.length ?? 0;
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
    if (this.pipeSourceStream && this.pipeSourceEndListener) {
      this.pipeSourceStream.off('end', this.pipeSourceEndListener);
      this.pipeSourceStream.off('close', this.pipeSourceEndListener);
    }
    this.pipeSourceStream = undefined;
    this.pipeSourceDataListener = undefined;
    this.pipeSourceErrorListener = undefined;
    this.pipeSourceEndListener = undefined;
  }
}
