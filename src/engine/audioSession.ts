import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import { FFMPEG_BINARY, FfmpegProcess } from '@/engine/ffmpegProcess';
import {
  mp3BitrateToBps,
  type AudioOutputSettings,
} from '@/engine/audioFormat';
import { RollingBuffer } from '@/engine/rollingBuffer';
import { SubscriberFanout } from '@/engine/subscriberFanout';
import { OutputPacer } from '@/engine/outputPacer';
import { PcmFrameAligner } from '@/engine/pcmFrameAligner';
import { codecPolicyForProfile, type CodecPolicy } from '@/engine/codecPolicy';
import { runPcmBlend } from '@/engine/pcmCrossfade';
import type { OutputProfile } from '@/ports/EngineTypes';
import type { EngineSessionStats } from '@/ports/EnginePort';
import { FfmpegArgBuilder, FFMPEG_LOW_LATENCY_ARGS } from '@/engine/ffmpegArgs';
import { PipeSourceAdapter } from '@/engine/pipeSourceAdapter';
import { TwoStagePipeline } from '@/engine/twoStagePipeline';

export type { OutputProfile };

export type PlaybackSource =
  | {
      kind: 'file';
      path: string;
      loop?: boolean;
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


export class AudioSession {
  private readonly log = createLogger('Audio', 'Session');
  private readonly fanout: SubscriberFanout;
  private process?: FfmpegProcess;
  private ending = false;
  private readonly ffmpegPath = FFMPEG_BINARY;

  private readonly buffer: RollingBuffer;
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
  private readonly sourcePreDelayMs?: number;
  private debugTapStream?: fs.WriteStream;
  private readonly pipeSource = new PipeSourceAdapter();
  private directPipeMode = false;
  // Two-stage PCM pipeline (decoder → pcmPipe → encoderInput → encoder).
  // Public fields on the pipeline object since crossfade orchestration needs to
  // unpipe/replace them mid-blend; see twoStagePipeline.ts for the contract.
  private readonly pipeline: TwoStagePipeline;
  private crossfadeActive = false;
  private discardSubscribersOnStop = false;
  private restartingForEq = false;
  private stdoutPaused = false;
  private readonly pacer: OutputPacer;
  // When streaming raw PCM, ensure we only emit full audio frames.
  // Otherwise, a subscriber that attaches mid-stream can start at an arbitrary byte offset,
  // which results in loud noise (misaligned sample boundaries).
  private readonly pcmAligner: PcmFrameAligner | null;
  private readonly codec: CodecPolicy;
  private readonly args: FfmpegArgBuilder;
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
    const alertBufferBytes = isAlertSource
      ? Math.round(
          (alertPrebufferMs / 1000) *
            (outputSettings.sampleRate * outputSettings.channels * (outputSettings.pcmBitDepth / 8)),
        )
      : 0;
    let maxBufferBytes: number;
    if (!Number.isFinite(candidate) || candidate <= 0) {
      // Allow disabling the rolling buffer; we still stream live without caching chunks.
      maxBufferBytes = 0;
    } else {
      // Allow larger prebuffer when upstream requests it (e.g., Sendspin wants ~5s).
      // Keep a safety cap to avoid unbounded memory; 4MB is still modest.
      const requested = Math.min(candidate, hardMax);
      maxBufferBytes = Math.max(requested, hardMin);
    }
    if (alertBufferBytes > 0) {
      const clampedAlert = Math.min(hardMax, Math.max(alertBufferBytes, hardMin));
      maxBufferBytes = Math.max(maxBufferBytes, clampedAlert);
    }
    this.buffer = new RollingBuffer(maxBufferBytes, isAlertSource);
    this.fanout = new SubscriberFanout(
      {
        pause: () => this.pauseStdout(),
        resume: () => this.resumeStdout(),
      },
      this.log,
      1024 * 1024,
    );

    // When URL input pacing is explicitly disabled (realTime=false), ffmpeg may process finite
    // sources (e.g. Apple Music track MP4s) far ahead of wall clock time and then exit,
    // terminating the session while pull-based outputs (Cast) still expect a live stream.
    // We prevent that by backpressuring ffmpeg stdout to keep a bounded lead buffer.
    const pacingBps = this.computePacingBps() ?? 0;
    const minLeadBytes =
      pacingBps > 0 && this.targetLeadMs > 0
        ? Math.round((pacingBps * this.targetLeadMs) / 1000)
        : 0;
    const pacingMaxAheadBytes = Math.max(minLeadBytes, maxBufferBytes, 0);
    this.pacer = new OutputPacer(
      pacingBps,
      pacingMaxAheadBytes,
      {
        hasBackpressure: () => this.fanout.hasBackpressure(),
        subscriberCount: () => this.fanout.size,
      },
      {
        pause: () => this.pauseStdout(),
        resume: () => this.resumeStdout(),
      },
      this.log,
      { zoneId: this.zoneId, profile: this.profile },
    );

    this.pcmAligner =
      this.profile === 'pcm'
        ? new PcmFrameAligner(this.outputSettings.channels, this.outputSettings.pcmBitDepth)
        : null;
    this.codec = codecPolicyForProfile(this.profile);
    this.args = new FfmpegArgBuilder(
      this.source,
      this.profile,
      this.outputSettings,
      isAlertSource,
      this.sourcePreDelayMs,
    );
    this.pipeline = new TwoStagePipeline(this.log, { zoneId: this.zoneId, profile: this.profile });
  }

  private alignPcmChunk(chunk: Buffer): Buffer | null {
    return this.pcmAligner ? this.pcmAligner.align(chunk) : chunk;
  }

  private bufferedChunkStartsWithCodecHeader(): boolean {
    const firstBufferedChunk = this.buffer.firstChunk();
    return Boolean(firstBufferedChunk && this.codec.startsWithHeader(firstBufferedChunk));
  }

  public start(): void {
    if (this.process) {
      return;
    }
    this.buffer.clear();
    this.pcmAligner?.reset();
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
      maxBufferBytes: this.buffer.capacity,
      targetLeadMs: this.targetLeadMs,
      outputSampleRate: this.outputSettings.sampleRate,
      outputChannels: this.outputSettings.channels,
      outputBitDepth: this.outputSettings.pcmBitDepth,
      profile: this.profile,
    });

    if (this.source.kind === 'pipe' && this.source.stream) {
      const pipeSource = this.source as typeof this.source & { stream: NodeJS.ReadableStream };
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
        !this.sourcePreDelayMs;

      if (canDirectPassthrough) {
        this.startDirectPipe(pipeSource.stream, fmt, sr, ch);
      } else {
        this.startPipeWithFfmpeg(pipeSource.stream, fmt, sr, ch);
      }
      return;
    }

    // File and URL sources use the two-stage PCM pipeline so crossfade can be
    // performed by blending raw PCM without switching the HTTP stream.
    if (this.source.kind === 'file' || this.source.kind === 'url') {
      this.startTwoStage();
      return;
    }

    this.startSingleStage();
  }

  /**
   * Pipe source, profile=pcm, format/rate/channels already match output settings, no
   * filter chain needed. Stream bytes straight to subscribers without an ffmpeg hop.
   */
  private startDirectPipe(
    stream: NodeJS.ReadableStream,
    fmt: string,
    sr: number,
    ch: number,
  ): void {
    this.pipeSource.adopt(stream);
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
    this.pipeSource.onData((chunk: Buffer) => {
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
      this.buffer.push(aligned);
      this.recordBytes(chunk.length);
      this.writeToSubscribers(aligned);
    });
    this.pipeSource.onError((err: unknown) => {
      this.log.warn('pipe source error', {
        zoneId: this.zoneId,
        message: (err as { message?: string } | null)?.message || String(err),
      });
      if (!this.ending) {
        this.cleanup();
      }
    });
    this.pipeSource.onEndOrClose(() => {
      this.log.debug('pipe source ended', { zoneId: this.zoneId, profile: this.profile });
      if (!this.ending) {
        this.cleanup();
      }
    });
    this.restartAttempts = 0;
  }

  /**
   * Pipe source that needs filter/codec conversion. PCM is bridged through pcmPipe →
   * encoderInput so a crossfade can swap the source without dropping ffmpeg.
   */
  private startPipeWithFfmpeg(
    stream: NodeJS.ReadableStream,
    fmt: string,
    sr: number,
    ch: number,
  ): void {
    this.pipeSource.detach(this.pipeline.pcmPipe);
    this.pipeSource.adopt(stream);
    const paceInput = (this.source as { realTime?: boolean }).realTime !== false;
    // When pacing is enabled, apply -re so ffmpeg throttles to real-time. Without it,
    // ffmpeg may read from the upstream pipe as fast as possible which makes the
    // Sendspin timestamps run ahead of wall clock and causes the client to speed up.
    // buildLowLatencyArgs() includes -probesize 32k -analyzeduration 0 even though the
    // format is explicitly specified via -f. This is intentional: even with an explicit
    // format, ffmpeg still runs an analyze phase that buffers ~1.1 s of PCM before
    // producing any output. Setting analyzeduration=0 reduces that to ~50 ms.
    const inputArgs = [
      ...FFMPEG_LOW_LATENCY_ARGS,
      ...(paceInput ? ['-re'] : []),
      '-f', fmt,
      '-ar', String(sr),
      '-ac', String(ch),
      '-i', 'pipe:0',
    ];
    const args = [
      '-hide_banner', '-loglevel', this.args.getLogLevel(),
      ...inputArgs,
      ...this.args.buildOutputArgs(this.equalizerBands),
      'pipe:1',
    ];

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
    // stream → pcmPipe → encoderInput → FFmpeg.stdin
    const pcmBridge = new PassThrough();
    const encInput = new PassThrough();
    this.pipeline.pcmPipe = pcmBridge;
    this.pipeline.encoderInput = encInput;
    stream.pipe(pcmBridge, { end: false });
    pcmBridge.pipe(encInput, { end: false });

    this.pipeSource.onEndOrClose(() => {
      try { stream.unpipe(pcmBridge); } catch { /* ignore */ }
      if (!this.crossfadeActive && !this.ending) encInput.end();
    });
    this.pipeSource.onError((err: unknown) => {
      this.log.warn('pipe source error', {
        zoneId: this.zoneId,
        message: err instanceof Error ? err.message : String(err),
      });
      encInput.destroy();
    });

    this.startTs = Date.now();
    let proc: FfmpegProcess;
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
    this.pipeSource.onData((chunk: Buffer) => {
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
    });

    this.process = proc;
    this.restartAttempts = 0;
  }

  /**
   * Pipe source without an attached stream (rare fallback). Builds input args from
   * the source path and runs a single ffmpeg without the pcmPipe/encoderInput bridge.
   */
  private startSingleStage(): void {
    const args = [
      '-hide_banner', '-loglevel', this.args.getLogLevel(),
      ...this.args.buildInputArgs(),
      ...this.args.buildOutputArgs(this.equalizerBands),
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
    this.process = this.spawnFfmpeg(args, {
      // After the file/url guard, only pipe/crossfade sources reach here.
      restartOnFailure: this.source.kind === 'pipe',
      logFirstChunk: true,
    });
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
  ): FfmpegProcess {
    const proc = new FfmpegProcess(
      args,
      {
        onStdout: (chunk: Buffer) => {
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
            this.codecHeader = this.codec.captureHeader(aligned);
          }
          this.buffer.push(aligned);
          this.recordBytes(chunk.length);
          this.writeToSubscribers(aligned);
          this.maybeApplyOutputPacing();
        },
        onStderr: (message: string) => {
          this.lastStderrLine = message;
          this.lastStderrAt = Date.now();
          this.log.debug('ffmpeg stderr', { zoneId: this.zoneId, message });
        },
        onExit: (code, signal) => {
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
            bufferedBytes: this.buffer.bytes,
            subscribers: this.fanout.size,
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
        },
        onError: (error: NodeJS.ErrnoException) => {
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
        },
      },
      this.log,
      { logContext: { zoneId: this.zoneId, profile: this.profile } },
    );

    if (options.stdinStream) {
      options.stdinStream.pipe(proc.stdin);
      this.pipeSource.adopt(options.stdinStream);
      this.pipeSource.onError((err: unknown) => {
        this.log.warn('pipe source error', {
          zoneId: this.zoneId,
          message: (err as { message?: string } | null)?.message || String(err),
        });
        proc.stdin.destroy();
      });
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
    const activePipe = this.pipeSource.current();
    if (this.directPipeMode && activePipe) {
      return this.inlineCrossfadeFromDirectPipe(fadeIn, durationSec);
    }
    if (activePipe && this.pipeline.pcmPipe && this.pipeline.encoderInput && !this.pipeline.decoder) {
      return this.inlineCrossfadeFromPipeFFmpeg(fadeIn, durationSec);
    }
    if (!this.pipeline.pcmPipe || !this.pipeline.encoderInput || !this.pipeline.decoder) return false;
    if (fadeIn.kind === 'pipe') return false; // pipe fade-in requires pipe fade-out path

    const { sampleRate } = this.outputSettings;
    const totalFrames = Math.round(durationSec * sampleRate);

    // Spawn new decoder for the incoming track.
    const newDecoderArgs = this.args.buildPcmDecoderArgsForSource(fadeIn);
    const newDecoder = spawn(this.ffmpegPath, newDecoderArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    newDecoder.stderr?.on('data', (c: Buffer) => {
      const msg = c.toString().trim();
      if (msg) this.log.debug('new decoder stderr', { zoneId: this.zoneId, message: msg });
    });

    this.crossfadeActive = true;
    const oldDecoder = this.pipeline.decoder as ChildProcessWithoutNullStreams;

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
    this.pipeline.pcmPipe!.unpipe(this.pipeline.encoderInput);

    // Collect old PCM from pcmPipe (decoder still writes to it as normal).
    // Collect new PCM from the freshly-spawned decoder's stdout.
    const oldChunks: Buffer[] = [];
    const newChunks: Buffer[] = [];
    let oldEnded = false;
    let newEnded = false;

    this.pipeline.pcmPipe!.on('data', (c: Buffer) => oldChunks.push(c));
    // decoder→pcmPipe uses { end: false }, so pcmPipe never emits 'end' when the
    // decoder exits. Watch the decoder process exit directly instead.
    const onOldDecoderExit = () => { oldEnded = true; };
    oldDecoder.once('exit', onOldDecoderExit);
    // Explicitly resume the backpressure chain: unpiping from encoderInput may have
    // left pcmPipe and decoder.stdout in a paused state. Resume both to restart flow.
    this.pipeline.pcmPipe!.resume();
    oldDecoder.stdout.resume();
    newDecoder.stdout.on('data', (c: Buffer) => newChunks.push(c));
    newDecoder.stdout.on('end', () => { newEnded = true; });

    // Use a fixed-interval timer rather than a recursive setTimeout/drain chain.
    // The drain-based approach silently stalls when the encoder's stdout is paused
    // (e.g., subscriber briefly disconnected). setInterval always fires regardless
    // of downstream backpressure; we intentionally ignore write backpressure here
    // since the PCM trickles in at real-time rate (~1.76 KB per 10 ms tick).
    const { framesProcessed, newRem } = await runPcmBlend(oldChunks, newChunks, {
      channels: this.outputSettings.channels,
      totalFrames,
      getOldEnded: () => oldEnded,
      getNewEnded: () => newEnded,
      onBlendedFrame: (blended) => { this.pipeline.encoderInput?.write(blended); },
      log: this.log,
      logContext: { zoneId: this.zoneId },
    });

    // Crossfade complete — transition to new decoder only.
    this.crossfadeActive = false;
    // Remove all exit/error listeners before killing so the old decoder's exit does
    // NOT call encoderInput.end() (which would prematurely terminate the encoder).
    oldDecoder.off('exit', onOldDecoderExit);
    oldDecoder.removeAllListeners('exit');
    oldDecoder.removeAllListeners('error');
    this.pipeline.pcmPipe!.removeAllListeners('data');
    // Disconnect old decoder from old pcmPipe, then kill it.
    oldDecoder.stdout.unpipe(this.pipeline.pcmPipe!);
    oldDecoder.kill('SIGTERM');

    // Write any leftover new-decoder PCM buffered during blend.
    if (newRem.length) this.pipeline.encoderInput!.write(newRem);
    newDecoder.stdout.removeAllListeners('data');
    newDecoder.stdout.removeAllListeners('end');

    // Reconnect: newDecoder → fresh pcmPipe → encoderInput.
    const newPcmPipe = new PassThrough();
    this.pipeline.pcmPipe = newPcmPipe;
    this.pipeline.decoder = newDecoder;

    newDecoder.stdout.pipe(newPcmPipe, { end: false });
    newPcmPipe.pipe(this.pipeline.encoderInput!, { end: false });

    newDecoder.on('exit', (code, signal) => {
      this.log.debug('new decoder exited (after crossfade)', { zoneId: this.zoneId, code, signal });
      if (!this.crossfadeActive) this.pipeline.encoderInput?.end();
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
    const oldPipeStream = this.pipeSource.current();
    if (!this.pipeline.pcmPipe || !this.pipeline.encoderInput || !oldPipeStream) return false;

    const { sampleRate } = this.outputSettings;
    const totalFrames = Math.round(durationSec * sampleRate);

    // New source: either a decoder process (file/url) or a live pipe stream (Spotify-to-Spotify).
    let newSourceStream: NodeJS.ReadableStream;
    let newDecoder: ChildProcessWithoutNullStreams | undefined;
    if (fadeIn.kind === 'pipe') {
      newSourceStream = fadeIn.stream;
    } else {
      newDecoder = spawn(this.ffmpegPath, this.args.buildPcmDecoderArgsForSource(fadeIn), {
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

    this.pipeline.pcmPipe.unpipe(this.pipeline.encoderInput);

    const oldChunks: Buffer[] = [];
    const newChunks: Buffer[] = [];
    let oldEnded = false;
    let newEnded = false;

    this.pipeline.pcmPipe.on('data', (c: Buffer) => oldChunks.push(c));
    const onOldEnd = () => { oldEnded = true; };
    oldPipeStream.once('end', onOldEnd);
    this.pipeline.pcmPipe.resume();

    newSourceStream.on('data', (c: Buffer) => newChunks.push(c));
    newSourceStream.once('end', () => { newEnded = true; });

    const { framesProcessed, newRem } = await runPcmBlend(oldChunks, newChunks, {
      channels: this.outputSettings.channels,
      totalFrames,
      getOldEnded: () => oldEnded,
      getNewEnded: () => newEnded,
      onBlendedFrame: (blended) => this.pipeline.encoderInput?.write(blended),
      log: this.log,
      logContext: { zoneId: this.zoneId },
    });

    this.crossfadeActive = false;

    oldPipeStream.off('end', onOldEnd);
    this.pipeline.pcmPipe.removeAllListeners('data');
    this.pipeSource.detach(this.pipeline.pcmPipe);

    if (newRem.length) this.pipeline.encoderInput!.write(newRem);
    newSourceStream.removeAllListeners('data');
    newSourceStream.removeAllListeners('end');

    const newPcmPipe = new PassThrough();
    this.pipeline.pcmPipe = newPcmPipe;

    if (fadeIn.kind === 'pipe') {
      // Pipe fade-in: wire the new Spotify stream as the new pcmPipe source.
      this.pipeSource.adopt(fadeIn.stream);
      fadeIn.stream.pipe(newPcmPipe, { end: false });
      newPcmPipe.pipe(this.pipeline.encoderInput!, { end: false });
      this.pipeSource.onEndOrClose(() => {
        if (!this.crossfadeActive && !this.ending) this.pipeline.encoderInput?.end();
      });
      this.pipeSource.onError((err: unknown) => {
        this.log.warn('crossfade pipe stream error', { zoneId: this.zoneId, message: err instanceof Error ? err.message : String(err) });
        if (!this.crossfadeActive && !this.ending) this.pipeline.encoderInput?.end();
      });
    } else {
      // Decoder fade-in: wire the decoder as the new decoderProc.
      this.pipeline.decoder = newDecoder!;
      newDecoder!.stdout.pipe(newPcmPipe, { end: false });
      newPcmPipe.pipe(this.pipeline.encoderInput!, { end: false });
      newDecoder!.on('exit', (code, signal) => {
        this.log.debug('new decoder exited (after pipe-ffmpeg crossfade)', { zoneId: this.zoneId, code, signal });
        if (!this.crossfadeActive) this.pipeline.encoderInput?.end();
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
    const oldStreamAtEntry = this.pipeSource.current();
    if (!this.directPipeMode || !oldStreamAtEntry) return false;

    const { sampleRate } = this.outputSettings;
    const totalFrames = Math.round(durationSec * sampleRate);

    let newSourceStream: NodeJS.ReadableStream;
    let newDecoder: ChildProcessWithoutNullStreams | undefined;
    if (fadeIn.kind === 'pipe') {
      newSourceStream = fadeIn.stream;
    } else {
      newDecoder = spawn(this.ffmpegPath, this.args.buildPcmDecoderArgsForSource(fadeIn), {
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
      newDecoder.stderr?.on('data', (c: Buffer) => {
        const msg = c.toString().trim();
        if (msg) this.log.debug('new decoder stderr', { zoneId: this.zoneId, message: msg });
      });
      newSourceStream = newDecoder.stdout;
    }

    this.crossfadeActive = true;
    const oldStream = oldStreamAtEntry;

    this.log.info('PCM crossfade blend starting (direct-pipe)', {
      zoneId: this.zoneId, durationSec, totalFrames, fadeInKind: fadeIn.kind,
    });
    if (this.stdoutPaused) this.resumeStdout();

    // Strip the session-level data listener so the old stream goes silent for the
    // session; we add a private collector below for the duration of the blend.
    this.pipeSource.detach();

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

    const { framesProcessed, newRem } = await runPcmBlend(oldChunks, newChunks, {
      channels: this.outputSettings.channels,
      totalFrames,
      getOldEnded: () => oldEnded,
      getNewEnded: () => newEnded,
      onBlendedFrame: (blended) => {
        this.buffer.push(blended);
        this.writeToSubscribers(blended);
      },
      log: this.log,
      logContext: { zoneId: this.zoneId },
    });

    this.crossfadeActive = false;
    this.directPipeMode = false;

    oldStream.off('data', onOldData);
    oldStream.off('end', onOldEnd);

    if (newRem.length) {
      this.buffer.push(newRem);
      this.writeToSubscribers(newRem);
    }
    newSourceStream.removeAllListeners('data');
    newSourceStream.removeAllListeners('end');

    // Wire a pseudo-two-stage pipeline so future inlineCrossfade calls work on the new track.
    const newPcmPipe = new PassThrough();
    const newEncoderInput = new PassThrough();
    this.pipeline.pcmPipe = newPcmPipe;
    this.pipeline.encoderInput = newEncoderInput;

    newEncoderInput.on('data', (chunk: Buffer) => {
      const aligned = this.alignPcmChunk(chunk);
      if (aligned?.length) {
        this.buffer.push(aligned);
        this.writeToSubscribers(aligned);
      }
    });
    newEncoderInput.on('end', () => {
      if (!this.crossfadeActive && !this.ending) this.cleanup();
    });

    if (fadeIn.kind === 'pipe') {
      this.pipeSource.adopt(fadeIn.stream);
      fadeIn.stream.pipe(newPcmPipe, { end: false });
      newPcmPipe.pipe(newEncoderInput, { end: false });
      this.pipeSource.onEndOrClose(() => {
        if (!this.crossfadeActive && !this.ending) newEncoderInput.end();
      });
      this.pipeSource.onError((err: unknown) => {
        this.log.warn('crossfade pipe stream error', { zoneId: this.zoneId, message: err instanceof Error ? err.message : String(err) });
        if (!this.crossfadeActive && !this.ending) newEncoderInput.end();
      });
    } else {
      this.pipeline.decoder = newDecoder!;
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

  private pauseStdout(): void {
    // Never pause the encoder during an active PCM crossfade blend — the blend loop
    // writes directly to encoderInput and must not be blocked by subscriber backpressure.
    if (this.crossfadeActive) {
      return;
    }
    if (this.stdoutPaused) {
      return;
    }
    if (this.directPipeMode && this.pipeSource.pause()) {
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
    if (!this.stdoutPaused || this.fanout.hasBackpressure()) {
      return;
    }
    if (this.directPipeMode && this.pipeSource.resume()) {
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

  private maybeApplyOutputPacing(): void {
    if (!this.process) return;
    this.pacer.tick(this.totalBytes, this.startTs);
  }

  // ─── Two-stage PCM pipeline ────────────────────────────────────────────────

  /**
   * Starts the session as a two-stage PCM pipeline:
   *   Decoder FFmpeg (source → s16le PCM) → pcmPipe → encoderInput → Encoder FFmpeg (PCM → output)
   *
   * The encoderInput PassThrough is a stable bridge to the encoder stdin. Replacing pcmPipe
   * (during crossfade) does not disconnect the encoder, so Squeezelite never reconnects.
   */
  private startTwoStage(): void {
    this.startTs = Date.now();

    const decoderArgs = this.args.buildPcmDecoderArgs();
    this.log.debug('spawning ffmpeg (decoder)', { zoneId: this.zoneId, args: decoderArgs, profile: this.profile });
    this.pipeline.startDecoder(decoderArgs, () => this.crossfadeActive);

    const encoderArgs = this.args.buildPcmEncoderArgs();
    this.log.debug('spawning ffmpeg (encoder)', { zoneId: this.zoneId, args: encoderArgs, profile: this.profile });
    const encoderProc = this.spawnFfmpeg(encoderArgs, {
      logFirstChunk: true,
      stdinStream: this.pipeline.encoderInput,
    });
    this.process = encoderProc;
    this.restartAttempts = 0;
  }

  public stop(discardSubscribers = false): void {
    if (this.ending) {
      return;
    }
    this.ending = true;
    this.discardSubscribersOnStop = discardSubscribers;
    // In two-stage mode also kill the decoder; the encoder (this.process) is killed below.
    this.pipeline.terminateDecoder();
    if (this.process) {
      this.process.terminate();
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
    this.process.terminate();
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
    const primeWithBuffer = options.primeWithBuffer !== false;
    // For codec streams (FLAC), prepend the saved header so the subscriber's
    // decoder can initialize correctly even when joining mid-stream.
    const includeCodecHeader =
      this.codecHeader && (!primeWithBuffer || !this.bufferedChunkStartsWithCodecHeader());
    return this.fanout.attach({
      zoneId: this.zoneId,
      profile: this.profile,
      primeWithBuffer,
      label: options.label,
      codecHeader: includeCodecHeader ? this.codecHeader : null,
      primingChunks: primeWithBuffer ? this.buffer.snapshot() : undefined,
      pcmFrameRate:
        this.profile === 'pcm'
          ? {
              sampleRate: this.outputSettings.sampleRate,
              channels: this.outputSettings.channels,
              bitDepth: this.outputSettings.pcmBitDepth,
            }
          : null,
      sessionBufferedBytes: this.buffer.bytes,
    });
  }

  public getStats(): EngineSessionStats {
    const drops = this.fanout.drops;
    return {
      profile: this.profile,
      bps: this.lastBpsTs ? this.lastBps : null,
      bufferedBytes: this.buffer.bytes,
      totalBytes: this.totalBytes,
      lastUpdated: this.lastBpsTs || null,
      subscribers: this.fanout.size,
      restarts: this.restartAttempts,
      lastError: this.lastErrorMessage,
      lastErrorAt: this.lastErrorAt,
      lastStderr: this.lastStderrLine,
      lastStderrAt: this.lastStderrAt,
      lastExitCode: this.lastExitCode,
      lastExitSignal: this.lastExitSignal,
      lastExitAt: this.lastExitAt,
      subscriberDrops: drops.count,
      lastSubscriberDropAt: drops.lastAt,
    };
  }

  private cleanup(options: { suppressTermination?: boolean } = {}): void {
    const suppressTermination = options.suppressTermination === true;
    this.bytesSinceLog = 0;
    this.lastLogTs = 0;
    this.pacer.reset();
    this.pipeSource.detach(this.pipeline.pcmPipe);
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
      this.process.detach();
      this.process = undefined;
    }
    this.fanout.clearAllBackpressure();
    this.stdoutPaused = false;
    // When suppressTermination is true, ffmpeg is restarting internally (restartOnFailure).
    // Keep subscribers alive so the sync stream and downstream clients (e.g. Squeezelite)
    // stay connected and receive audio from the new ffmpeg process without interruption.
    if (!suppressTermination) {
      this.fanout.endAll(this.discardSubscribersOnStop);
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
    this.fanout.write(chunk);
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
      bufferBytes: this.buffer.bytes,
      subscribers: this.fanout.size,
      labels: this.fanout.labels(),
    });
    this.lastLogTs = now;
    this.bytesSinceLog = 0;
  }

  private recordBytes(length: number): void {
    this.bytesSinceLog += length;
    this.totalBytes += length;
    this.maybeLogThroughput();
  }

}
