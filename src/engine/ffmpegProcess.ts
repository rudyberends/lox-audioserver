import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Writable } from 'node:stream';
import ffmpegStatic from 'ffmpeg-static';

const DEFAULT_KILL_TIMEOUT_MS = 2000;

export const FFMPEG_BINARY: string =
  typeof ffmpegStatic === 'string' && ffmpegStatic ? ffmpegStatic : 'ffmpeg';

export interface FfmpegLogger {
  debug(message: string, context?: Record<string, unknown>): void;
}

export interface FfmpegHandlers {
  onStdout(chunk: Buffer): void;
  onStderr(line: string): void;
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
  onError(error: NodeJS.ErrnoException): void;
}

/**
 * Owns one ffmpeg child process. Wraps spawn + stdout/stderr/exit/error
 * wiring + the SIGTERM-then-SIGKILL kill-timer. All audio-domain logic
 * (alignment, codec-header capture, restart policy) lives in the caller.
 */
export class FfmpegProcess {
  private readonly proc: ChildProcessWithoutNullStreams;
  private killTimer?: NodeJS.Timeout;
  private readonly killTimeoutMs: number;

  constructor(
    args: string[],
    handlers: FfmpegHandlers,
    private readonly log: FfmpegLogger,
    options: { killTimeoutMs?: number; binary?: string; logContext?: Record<string, unknown> } = {},
  ) {
    this.killTimeoutMs = options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;
    const binary = options.binary ?? FFMPEG_BINARY;
    const context = options.logContext;

    this.proc = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;

    this.proc.stdout.on('data', handlers.onStdout);
    this.proc.stdout.on('close', () => {
      this.log.debug('ffmpeg stdout closed', context);
    });
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const message = chunk.toString().trim();
      if (message) handlers.onStderr(message);
    });
    this.proc.on('exit', (code, signal) => handlers.onExit(code, signal));
    this.proc.on('error', (err) => handlers.onError(err as NodeJS.ErrnoException));
  }

  public get stdin(): Writable {
    return this.proc.stdin;
  }

  public get stdout(): NodeJS.ReadableStream {
    return this.proc.stdout;
  }

  public get killed(): boolean {
    return this.proc.killed;
  }

  public pauseStdout(): void {
    this.proc.stdout.pause();
  }

  public resumeStdout(): void {
    this.proc.stdout.resume();
  }

  /** SIGTERM, then SIGKILL after killTimeoutMs if still alive. */
  public terminate(): void {
    this.proc.kill('SIGTERM');
    this.armKillTimer();
  }

  /** Strip all listeners and stop the kill-timer. Used on cleanup / restart. */
  public detach(): void {
    this.proc.removeAllListeners();
    this.proc.stdout?.removeAllListeners();
    this.proc.stderr?.removeAllListeners();
    this.clearKillTimer();
  }

  private armKillTimer(): void {
    this.clearKillTimer();
    this.killTimer = setTimeout(() => {
      if (!this.proc.killed) this.proc.kill('SIGKILL');
    }, this.killTimeoutMs);
  }

  private clearKillTimer(): void {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = undefined;
    }
  }
}
