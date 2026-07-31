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
import type { OutputProfile } from '@/ports/EngineTypes';
import type { EngineSessionStats } from '@/ports/EnginePort';
import type { SessionKey } from '@/ports/types/SessionKey';
import { FfmpegArgBuilder, type SourceNativeFormat } from '@/engine/ffmpegArgs';
import { getCachedSourceFormat } from '@/engine/sourceProbe';
import { PipeSourceAdapter } from '@/engine/pipeSourceAdapter';
import { TwoStagePipeline } from '@/engine/twoStagePipeline';
import { FirstChunkBarrier } from '@/engine/firstChunkBarrier';
import { SessionStarter } from '@/engine/sessionStarter';
import { Crossfader } from '@/engine/crossfader';

export type { OutputProfile };

import type { PlaybackSource } from '@/engine/playbackSource';
export type { PlaybackSource };

// Internal restart-on-failure backoff. The counter tracks *consecutive* failed
// restarts and is reset to 0 once the restarted ffmpeg produces its first chunk
// (i.e. it actually recovered). Without that reset a transient failure would
// permanently consume the budget; without the cap a persistently failing source
// would hot-loop forever.
const MAX_RESTART_ATTEMPTS = 5;
const RESTART_BACKOFF_STEP_MS = 100;
const RESTART_BACKOFF_MAX_MS = 500;

function pcmBitDepthFor(format: string): 16 | 24 | 32 {
  if (format === 's16le' || format === 's16be') return 16;
  if (format === 's24le') return 24;
  return 32;
}

function sourceFormatFor(
  source: PlaybackSource,
  nativeFormat: SourceNativeFormat | undefined,
): EngineSessionStats['sourceFormat'] {
  if (nativeFormat) {
    return {
      codec: nativeFormat.codecName ?? 'unknown',
      sampleRate: nativeFormat.sampleRate,
      channels: nativeFormat.channels,
      bitDepth: nativeFormat.bitDepth,
      bitrate: null,
    };
  }
  if (source.kind !== 'pipe' || !source.sampleRate || !source.channels || !source.format) {
    return null;
  }
  const bitDepth = pcmBitDepthFor(source.format);
  return {
    codec: 'pcm',
    sampleRate: source.sampleRate,
    channels: source.channels,
    bitDepth,
    bitrate: source.sampleRate * source.channels * bitDepth,
  };
}

export class AudioSession {
  // ─── Internals exposed for SessionStarter and Crossfader ─────────────────
  // The fields and helpers below carry `@internal` semantics: they are public
  // for cross-module orchestration (sessionStarter.ts, crossfader.ts) but are
  // NOT part of the EnginePort surface — external consumers should only use
  // start/stop/createSubscriber/etc. on this class.

  /** @internal */ public readonly log = createLogger('Audio', 'Session');
  /** @internal */ public readonly fanout: SubscriberFanout;
  /** @internal */ public process?: FfmpegProcess;
  /** @internal */ public ending = false;
  /** @internal */ public readonly ffmpegPath = FFMPEG_BINARY;

  /** @internal */ public readonly buffer: RollingBuffer;
  /** @internal */ public readonly firstChunk = new FirstChunkBarrier();
  private bytesSinceLog = 0;
  private lastLogTs = 0;
  private totalBytes = 0;
  private lastBps = 0;
  private lastBpsTs = 0;
  // Consecutive failed restarts (backoff budget); reset to 0 on first chunk after recovery.
  private restartAttempts = 0;
  // Lifetime restart count for stats; never reset on recovery (unlike restartAttempts).
  private totalRestarts = 0;
  private readonly targetLeadMs: number;
  private lastStderrLine: string | null = null;
  private lastStderrAt: number | null = null;
  private lastErrorMessage: string | null = null;
  private lastErrorAt: number | null = null;
  private lastExitCode: number | null = null;
  private lastExitSignal: string | null = null;
  private lastExitAt: number | null = null;
  /** @internal */ public startTs: number | null = null;
  private readonly sourcePreDelayMs?: number;
  private sourceFormat: EngineSessionStats['sourceFormat'];
  private readonly bitPerfect: boolean;
  private readonly dspApplied: boolean;
  private debugTapStream?: fs.WriteStream;
  /** @internal */ public readonly pipeSource = new PipeSourceAdapter();
  /** @internal */ public directPipeMode = false;
  // Two-stage PCM pipeline (decoder → pcmPipe → encoderInput → encoder).
  // Public fields on the pipeline object since crossfade orchestration needs to
  // unpipe/replace them mid-blend; see twoStagePipeline.ts for the contract.
  /** @internal */ public readonly pipeline: TwoStagePipeline;
  /** @internal */ public crossfadeActive = false;
  private discardSubscribersOnStop = false;
  private restartingForEq = false;
  /** @internal */ public stdoutPaused = false;
  private readonly pacer: OutputPacer;
  // When streaming raw PCM, ensure we only emit full audio frames.
  // Otherwise, a subscriber that attaches mid-stream can start at an arbitrary byte offset,
  // which results in loud noise (misaligned sample boundaries).
  /** @internal */ public readonly pcmAligner: PcmFrameAligner | null;
  /** @internal */ public readonly codec: CodecPolicy;
  /** @internal */ public readonly args: FfmpegArgBuilder;
  // For codec streams (FLAC, etc.), store the initial header so new subscribers
  // joining mid-stream can initialize their decoders correctly.
  /** @internal */ public codecHeader: Buffer | null = null;
  private readonly starter: SessionStarter;
  private readonly crossfader: Crossfader;

  constructor(
    /**
     * @internal Engine session key. For zone playback this equals the zoneId;
     * for a non-zone consumer it is an ephemeral key. Used only as a log/label
     * value here — the session carries no zone semantics.
     */
    public readonly zoneId: SessionKey,
    /** @internal */ public readonly source: PlaybackSource,
    /** @internal */ public readonly profile: OutputProfile,
    private readonly onTerminated: () => void,
    /** @internal */ public readonly outputSettings: AudioOutputSettings,
    /** @internal */ public equalizerBands: ReadonlyArray<number> | null = null,
    /**
     * When true (default), file/URL sources use the two-stage pipeline
     * (decoder + encoder) so inlineCrossfade can blend PCM mid-stream. When
     * false, file/URL run a single ffmpeg — half the process count and no
     * encoderInput/pcmPipe state. Set by AudioStreamEngine based on the
     * system-wide `audioserver.crossfadeSec` config.
     */
    public readonly crossfadeEnabled: boolean = true,
    /** Receives aligned PCM frames for protocol-neutral realtime analysis. */
    private readonly onPcmFrame?: (zoneId: SessionKey, pcm: Buffer, timestampUs: number) => void,
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
    // Bit-perfect passthrough needs the source's native format. The probe is async
    // and this constructor is not, so we only read the cache that the caller
    // (e.g. sendspinOutput before engine.start) populated. A cache miss simply
    // means "resample as before" — never a stall.
    // URL sources carry a provider-declared format (no probing — see sourceProbe);
    // local files use the cache that the caller populated before engine.start.
    const nativeFormat = ((): SourceNativeFormat | undefined => {
      if (this.source.kind === 'url') {
        const declared = this.source.nativeFormat;
        if (!declared) {
          return undefined;
        }
        return {
          sampleRate: declared.sampleRate,
          channels: declared.channels,
          bitDepth: declared.bitDepth ?? null,
          lossless: declared.lossless,
          codecName: declared.codecName,
        };
      }
      if (this.source.kind === 'file') {
        return getCachedSourceFormat(this.source.path) ?? undefined;
      }
      return undefined;
    })();
    this.sourceFormat = sourceFormatFor(this.source, nativeFormat);
    this.args = new FfmpegArgBuilder(
      this.source,
      this.profile,
      this.outputSettings,
      isAlertSource,
      this.sourcePreDelayMs,
      nativeFormat,
    );
    const losslessSource = nativeFormat?.lossless === true ||
      (this.sourceFormat?.codec.startsWith('pcm_') === true || this.sourceFormat?.codec === 'flac');
    this.bitPerfect = losslessSource && this.args.isBitPerfect(this.equalizerBands);
    this.dspApplied = !this.args.isBitPerfect(this.equalizerBands);
    this.pipeline = new TwoStagePipeline(this.log, { zoneId: this.zoneId, profile: this.profile });
    this.starter = new SessionStarter(this);
    this.crossfader = new Crossfader(this);
  }

  /** @internal */ public alignPcmChunk(chunk: Buffer): Buffer | null {
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
    this.firstChunk.arm();
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
        this.starter.startDirectPipe(pipeSource.stream, fmt, sr, ch);
      } else {
        this.starter.startPipeWithFfmpeg(pipeSource.stream, fmt, sr, ch);
      }
      return;
    }

    // File and URL sources use the two-stage PCM pipeline so crossfade can be
    // performed by blending raw PCM without switching the HTTP stream — but
    // only when crossfade is enabled. With crossfade off we save one ffmpeg
    // process per zone by running single-stage.
    if (this.source.kind === 'file' || this.source.kind === 'url') {
      if (this.crossfadeEnabled) {
        this.starter.startTwoStage();
      } else {
        this.starter.startSingleStage();
      }
      return;
    }

    this.starter.startSingleStage();
  }


  /** @internal */ public spawnFfmpeg(
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
          if (this.firstChunk.signal()) {
            // Restarted ffmpeg produced output → it recovered; reset the backoff budget.
            this.restartAttempts = 0;
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
          if (this.profile === 'pcm') {
            this.onPcmFrame?.(this.zoneId, aligned, Date.now() * 1000);
          }
          this.writeToSubscribers(aligned);
          this.maybeApplyOutputPacing();
        },
        onStderr: (message: string) => {
          this.lastStderrLine = message;
          this.lastStderrAt = Date.now();
          this.observeSourceFormat(message);
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
          const wantsRestart =
            !shouldRestartForEq && options.restartOnFailure === true && !this.ending && code !== 0;
          const restartBudgetExhausted = this.restartAttempts >= MAX_RESTART_ATTEMPTS;
          const shouldRestart = wantsRestart && !restartBudgetExhausted;
          // When we give up (budget exhausted), suppressTermination=false so cleanup
          // fully tears the session down instead of leaving it in limbo.
          this.cleanup({ suppressTermination: shouldRestart || shouldRestartForEq });
          if (shouldRestartForEq) {
            this.restartingForEq = false;
            setTimeout(() => this.start(), 0);
            return;
          }
          if (shouldRestart) {
            this.restartAttempts += 1;
            this.totalRestarts += 1;
            const delayMs = Math.min(
              RESTART_BACKOFF_MAX_MS,
              RESTART_BACKOFF_STEP_MS * this.restartAttempts,
            );
            setTimeout(() => this.start(), delayMs);
            return;
          }
          if (wantsRestart && restartBudgetExhausted) {
            this.log.error('ffmpeg restart budget exhausted; giving up', {
              zoneId: this.zoneId,
              profile: this.profile,
              attempts: this.restartAttempts,
            });
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
   * PCM crossfade between the currently-playing source and a fade-in source.
   * Dispatches to one of three topologies (two-stage decoder, pipe-with-ffmpeg,
   * direct passthrough) implemented in {@link Crossfader}.
   */
  public inlineCrossfade(
    fadeIn:
      | { kind: 'file'; path: string }
      | { kind: 'url'; url: string; headers?: Record<string, string>; decryptionKey?: string }
      | { kind: 'pipe'; stream: NodeJS.ReadableStream; sampleRate: number; channels: number },
    durationSec: number,
  ): Promise<boolean> {
    return this.crossfader.inlineCrossfade(fadeIn, durationSec);
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

  /** @internal */ public resumeStdout(): void {
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

  public waitForFirstChunk(timeoutMs = 2000): Promise<boolean> {
    return this.firstChunk.wait(timeoutMs);
  }

  public hasFirstChunk(): boolean {
    return this.firstChunk.hasFired();
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

  /**
   * Fill in the source format from ffmpeg's own probe, when nobody could tell us.
   *
   * A stream URL arrives with a native format only if its provider declares one. Apple Music does;
   * TuneIn and most radio do not — so the API reported "source not reported" for the whole track while
   * ffmpeg had already printed the answer on stderr and we had asked it not to (see `getLogLevel`, which
   * raises the level to `info` for exactly this case).
   *
   * The line looks like:
   *   `Stream #0:0: Audio: aac (LC) ([mp4a / 0x6134706D]), 44100 Hz, stereo, fltp, 256 kb/s`
   *
   * **It cannot change the passthrough decision.** `bitPerfect`/`dspApplied` were settled when the
   * command line was built, and ffmpeg is already running it: a resampler that is in the args stays in
   * the args, so learning the rate afterwards must not start claiming a bypass that did not happen. This
   * only fills in what is *reported*. A provider that declares its format up front is still the only way
   * to actually skip the resampler — which is why the declaration matters and this is the fallback.
   */
  private observeSourceFormat(message: string): void {
    if (this.sourceFormat) {
      return;
    }
    const match = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Audio: ([A-Za-z0-9_]+)[^,]*, (\d+) Hz, ([^,]+)(?:, ([a-z0-9]+))?(?:, (\d+) kb\/s)?/.exec(
      message,
    );
    if (!match) {
      return;
    }
    const [, codec, rate, layout, sampleFmt, kbps] = match;
    const sampleRate = Number(rate);
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      return;
    }
    const channels = layout?.includes('mono')
      ? 1
      : layout?.includes('stereo')
        ? 2
        : Number(/^(\d+)/.exec(layout ?? '')?.[1] ?? 2);
    /*
     * Depth only for codecs that have one to preserve.
     *
     * A lossy stream's decoder sample format (`fltp`) describes ffmpeg's float pipeline, not the
     * recording — reporting 32 bits for an AAC would be the padding mistake in a different place.
     */
    const lossless = ['flac', 'alac', 'pcm', 'wav', 'aiff'].some((name) => codec?.startsWith(name));
    const bitDepth = lossless
      ? sampleFmt === 's16' || sampleFmt === 's16p'
        ? 16
        : sampleFmt === 's32' || sampleFmt === 's32p'
          ? 32
          : null
      : null;
    this.sourceFormat = {
      codec: codec ?? 'unknown',
      sampleRate,
      channels: Number.isFinite(channels) && channels > 0 ? channels : 2,
      bitDepth,
      bitrate: kbps ? Number(kbps) * 1000 : null,
    };
    this.log.debug('source format read from ffmpeg', {
      zoneId: this.zoneId,
      format: this.sourceFormat,
    });
  }

  public getStats(): EngineSessionStats {
    const drops = this.fanout.drops;
    return {
      profile: this.profile,
      sampleRate: this.outputSettings.sampleRate,
      channels: this.outputSettings.channels,
      pcmBitDepth: this.outputSettings.pcmBitDepth,
      bps: this.lastBpsTs ? this.lastBps : null,
      bitPerfect: this.bitPerfect,
      dspApplied: this.dspApplied,
      // Described from the live equalizer bands rather than from the ones this session started with:
      // a band moved mid-track restarts ffmpeg, and until it does the chain in the args is the old one.
      processing: this.args.describeProcessing(this.equalizerBands),
      crossfading: this.crossfadeActive,
      sourceFormat: this.sourceFormat,
      bufferedBytes: this.buffer.bytes,
      totalBytes: this.totalBytes,
      lastUpdated: this.lastBpsTs || null,
      subscribers: this.fanout.size,
      restarts: this.totalRestarts,
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

  /** @internal */ public cleanup(options: { suppressTermination?: boolean } = {}): void {
    const suppressTermination = options.suppressTermination === true;
    this.bytesSinceLog = 0;
    this.lastLogTs = 0;
    this.pacer.reset();
    this.pipeSource.detach(this.pipeline.pcmPipe);
    this.directPipeMode = false;
    if (suppressTermination) {
      // ffmpeg is restarting; chain existing waiters to the next arm() cycle so the
      // position ticker does not start prematurely before the restarted process produces output.
      this.firstChunk.chainRestart();
    } else {
      this.firstChunk.abort();
    }
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

  /** @internal */ public writeToSubscribers(chunk: Buffer): void {
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

  /** @internal */ public recordBytes(length: number): void {
    this.bytesSinceLog += length;
    this.totalBytes += length;
    this.maybeLogThroughput();
  }

}
