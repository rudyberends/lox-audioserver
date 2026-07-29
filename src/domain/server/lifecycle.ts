/**
 * Whether the server is ready to serve, and since when.
 *
 * This exists because "the process is running" and "the server works" are not the same
 * claim, and until now only the first was observable. Startup logged `startup complete`
 * and nothing else: no flag, no event, nothing to ask. Supervisors therefore had to guess
 * — the LoxBerry plugin greps `docker ps` on a five-minute cron and treats a container in
 * `Up` state as healthy, which is true of a container that has not opened a socket yet and
 * of one that is crash-looping between checks.
 *
 * The distinction that matters to a supervisor is *starting* versus *failed*: both look
 * like "not answering", but one resolves itself and the other needs intervention. A
 * restart is the same problem in miniature — a soft restart tears the HTTP service down
 * and builds it again, and during that window the server is legitimately not ready.
 *
 * Deliberately a tiny piece of state with no dependencies, so every layer can read it
 * without inverting the dependency graph.
 */

/**
 * `starting` covers first boot and the window inside a restart. `ready` means startup
 * finished. `failed` means it did not, and retrying by itself will not help.
 *
 * There is no `stopping`: a shutting-down server stops answering, and a verdict nobody can
 * read is not worth modelling.
 */
export type ServerPhase = 'starting' | 'ready' | 'failed';

export interface ServerLifecycleSnapshot {
  phase: ServerPhase;
  /** When the process started, regardless of phase. */
  startedAt: number;
  /**
   * When the server last became ready, or null while it never has.
   *
   * Distinct from `startedAt` on purpose: uptime measured from process start counts the
   * boot sequence as service, and after a restart it keeps counting across a window in
   * which nothing was served.
   */
  readyAt: number | null;
  /** Why startup failed, when it did. */
  error: string | null;
  /** How many times the server has become ready — more than once means it restarted. */
  readyCount: number;
}

/**
 * Tracks the phase transitions. One instance per process, created at bootstrap.
 *
 * `now` is injected so tests do not have to wait for a clock.
 */
export class ServerLifecycle {
  private phase: ServerPhase = 'starting';
  private readyAt: number | null = null;
  private error: string | null = null;
  private readyCount = 0;
  private readonly startedAt: number;

  constructor(private readonly now: () => number = () => Date.now()) {
    this.startedAt = this.now();
  }

  /** Startup finished. Clears any earlier failure: the server is serving now. */
  public markReady(): void {
    this.phase = 'ready';
    this.readyAt = this.now();
    this.error = null;
    this.readyCount += 1;
  }

  /**
   * A restart began, so the server is not ready until it says so again.
   *
   * Keeps `readyAt` as it was: it records when the server last became ready, and a restart
   * that fails should not erase the fact that it once worked.
   */
  public markStarting(): void {
    this.phase = 'starting';
    this.error = null;
  }

  /** Startup or a restart failed, with the reason a supervisor should surface. */
  public markFailed(error: unknown): void {
    this.phase = 'failed';
    this.error = error instanceof Error ? error.message : String(error);
  }

  public isReady(): boolean {
    return this.phase === 'ready';
  }

  public snapshot(): ServerLifecycleSnapshot {
    return {
      phase: this.phase,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      error: this.error,
      readyCount: this.readyCount,
    };
  }
}
