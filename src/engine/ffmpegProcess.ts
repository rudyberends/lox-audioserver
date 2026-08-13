import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Writable } from 'node:stream';
import ffmpegStatic from 'ffmpeg-static';
import { createLogger } from '@/shared/logging/logger';

const DEFAULT_KILL_TIMEOUT_MS = 2000;

const resolveLog = createLogger('Audio', 'FfmpegBinary');

/**
 * Encoders and the resampler every output profile depends on. A system ffmpeg that
 * cannot do these is worse than the bundled one, so it is skipped rather than
 * discovered at the first play.
 */
const REQUIRED_BUILD_FLAGS = ['--enable-libmp3lame', '--enable-libopus', '--enable-libsoxr'];

/** How long the one-off capability probe of a candidate binary may take. */
const VERSION_PROBE_TIMEOUT_MS = 5000;

export interface FfmpegBinaryChoice {
  path: string;
  /** Where it came from, for the startup log. */
  source: 'system' | 'bundled' | 'path-fallback';
  /** First line of `-version`, when we probed it. */
  version?: string;
}

export interface ResolveFfmpegDeps {
  /** `PATH`, searched in order for a system ffmpeg. */
  searchPath: string;
  /** True when the path is an existing, executable file. */
  isExecutable(candidate: string): boolean;
  /** `<candidate> -version` output, or null when it fails to run. */
  probeVersion(candidate: string): string | null;
  /** The bundled static binary, or null when the package resolved to nothing. */
  bundled: string | null;
}

/**
 * Pick the ffmpeg to spawn.
 *
 * The bundled `ffmpeg-static` binary is statically linked, and a static glibc cannot
 * `dlopen` the NSS modules that resolve hostnames — so *every* URL with a hostname in
 * it fails there, on some hosts by taking the process down with SIGSEGV before it logs
 * a single line (issue #336: a DLNA cast of a Plex URL). Two providers already work
 * around this by proxying their URLs through 127.0.0.1; a cast URI has no such
 * indirection, and neither does a radio stream.
 *
 * A distribution ffmpeg is dynamically linked and has no such problem, and the Docker
 * image installs one — it was simply never used. So prefer it, but only once it has
 * proven it can encode what we ask of it ({@link REQUIRED_BUILD_FLAGS}); a cut-down
 * build would trade a DNS failure for a missing-encoder one. Anything unproven falls
 * back to the bundled binary, which is what shipped before.
 */
export function resolveFfmpegBinary(deps: ResolveFfmpegDeps): FfmpegBinaryChoice {
  for (const candidate of systemCandidates(deps.searchPath, deps.isExecutable)) {
    const version = deps.probeVersion(candidate);
    if (!version) {
      continue;
    }
    const missing = REQUIRED_BUILD_FLAGS.filter((flag) => !version.includes(flag));
    if (missing.length) {
      resolveLog.debug('skipping system ffmpeg; build lacks required features', {
        path: candidate,
        missing,
      });
      continue;
    }
    return { path: candidate, source: 'system', version: firstLine(version) };
  }

  if (deps.bundled) {
    return { path: deps.bundled, source: 'bundled' };
  }
  return { path: 'ffmpeg', source: 'path-fallback' };
}

/** Every `ffmpeg` on PATH, in PATH order. */
function systemCandidates(
  searchPath: string,
  isExecutable: (candidate: string) => boolean,
): string[] {
  const names = process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg'];
  const dirs = searchPath.split(path.delimiter).filter(Boolean);
  const found: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (!found.includes(candidate) && isExecutable(candidate)) {
        found.push(candidate);
      }
    }
  }
  return found;
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0]?.trim() ?? '';
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) {
      return false;
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function probeVersion(candidate: string): string | null {
  try {
    return execFileSync(candidate, ['-hide_banner', '-version'], {
      encoding: 'utf8',
      timeout: VERSION_PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

let resolved: FfmpegBinaryChoice | null = null;

/**
 * The ffmpeg every spawn in the app uses. Resolved once, on first use rather than at
 * import, so the choice is logged after the logger is configured.
 */
export function ffmpegBinary(): string {
  if (!resolved) {
    resolved = resolveFfmpegBinary({
      searchPath: process.env.PATH ?? '',
      isExecutable: isExecutableFile,
      probeVersion,
      bundled: typeof ffmpegStatic === 'string' && ffmpegStatic ? ffmpegStatic : null,
    });
    resolveLog.info('ffmpeg binary selected', {
      path: resolved.path,
      source: resolved.source,
      version: resolved.version,
    });
    if (resolved.source === 'bundled') {
      // Worth saying out loud: this is the build whose name resolution can fail, and the
      // symptom (a stream that dies instantly with no ffmpeg output) does not point here.
      resolveLog.warn('using the bundled static ffmpeg; stream URLs with a hostname may fail', {
        hint: 'install ffmpeg with libmp3lame, libopus and libsoxr',
      });
    }
  }
  return resolved.path;
}

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
  private exited = false;

  constructor(
    args: string[],
    handlers: FfmpegHandlers,
    private readonly log: FfmpegLogger,
    options: { killTimeoutMs?: number; binary?: string; logContext?: Record<string, unknown> } = {},
  ) {
    this.killTimeoutMs = options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;
    const binary = options.binary ?? ffmpegBinary();
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
    this.proc.on('exit', (code, signal) => {
      this.exited = true;
      this.clearKillTimer();
      handlers.onExit(code, signal);
    });
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
      // NB: proc.killed only means "a signal was delivered", not "the process
      // exited" — so it is true right after the SIGTERM above and must NOT gate
      // the escalation. Track real exit instead, otherwise an ffmpeg wedged in
      // its -reconnect loop on a slow input never gets SIGKILLed and leaks.
      if (!this.exited) this.proc.kill('SIGKILL');
    }, this.killTimeoutMs);
  }

  private clearKillTimer(): void {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = undefined;
    }
  }
}
