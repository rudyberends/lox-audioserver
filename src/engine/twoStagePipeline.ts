import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { FFMPEG_BINARY } from '@/engine/ffmpegProcess';

export interface TwoStagePipelineLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

/**
 * Two-stage decode → encode pipeline used for file/URL sources.
 *
 *   decoder (source → s16le PCM) → pcmPipe → encoderInput → encoder (PCM → output)
 *
 * `encoderInput` is the permanent connection to encoder stdin; crossfade can swap
 * the decoder (and replace `pcmPipe`) without disconnecting the encoder, so
 * downstream HTTP clients (Squeezelite, Cast) never see a reconnect.
 *
 * Fields are public because crossfade orchestration on AudioSession needs to
 * read/write them directly (unpipe pcmPipe → encoderInput, replace pcmPipe with
 * a fresh PassThrough, rewire newDecoder.stdout → newPcmPipe → encoderInput).
 */
export class TwoStagePipeline {
  public decoder?: ChildProcessWithoutNullStreams;
  public pcmPipe?: PassThrough;
  public encoderInput?: PassThrough;

  constructor(
    private readonly log: TwoStagePipelineLogger,
    private readonly logContext: Record<string, unknown>,
  ) {}

  /**
   * Spawn the decoder ffmpeg with the supplied args and wire decoder.stdout →
   * pcmPipe → encoderInput. `isCrossfadeActive` is consulted on decoder exit so
   * encoderInput is not closed mid-crossfade (crossfade will reattach a new decoder).
   */
  public startDecoder(args: string[], isCrossfadeActive: () => boolean): void {
    this.encoderInput = new PassThrough();
    this.pcmPipe = new PassThrough();

    const proc = this.spawnDecoder(args, {
      onEnded: () => {
        if (!isCrossfadeActive()) {
          this.encoderInput?.end();
        }
      },
    });

    proc.stdout.pipe(this.pcmPipe, { end: false });
    this.pcmPipe.pipe(this.encoderInput, { end: false });
  }

  /**
   * Spawn a decoder and own its lifecycle without wiring the crossfade bridge.
   *
   * The engine-DSP topology feeds our own PCM stage instead of `pcmPipe`, but it wants the same
   * ownership: stderr on the session log, one `onEnded` for both exit and spawn failure, and
   * {@link terminateDecoder} to reach it.
   */
  public spawnDecoder(
    args: string[],
    handlers: { onEnded: (reason: 'exit' | 'error') => void },
  ): ChildProcessWithoutNullStreams {
    const proc = spawn(FFMPEG_BINARY, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.decoder = proc;

    proc.stderr?.on('data', (c: Buffer) => {
      const msg = c.toString().trim();
      if (msg) this.log.debug('decoder stderr', { ...this.logContext, message: msg });
    });
    proc.on('exit', (code, signal) => {
      this.log.debug('decoder exited', { ...this.logContext, code, signal });
      handlers.onEnded('exit');
    });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      this.log.warn('decoder error', { ...this.logContext, message: err.message });
      handlers.onEnded('error');
    });
    return proc;
  }

  public terminateDecoder(): void {
    const proc = this.decoder;
    if (!proc) return;
    proc.stdout.removeAllListeners();
    this.decoder = undefined;
    proc.kill('SIGTERM');
    // Escalate to SIGKILL if it does not exit (e.g. wedged in an -reconnect loop
    // on a slow input). Gate on real exit, not proc.killed (which is already true
    // after the SIGTERM above), or a stuck decoder leaks.
    const killTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }, 2000);
    proc.once('exit', () => clearTimeout(killTimer));
  }
}
