/**
 * Tracks the "have we produced the first audio chunk yet?" signal for a
 * session. Callers `arm()` before spawning ffmpeg, `signal()` from the first
 * data callback, and `wait(timeoutMs)` to gate any logic that depends on
 * the audio being live (position tickers, handoff completion checks).
 *
 * Restart semantics: when the session restarts ffmpeg internally (e.g.
 * `restartOnFailure`, EQ-change respawn), `chainRestart()` carries existing
 * waiters into the next arm() so they observe the new first chunk instead
 * of resolving prematurely on the previous one.
 */
export class FirstChunkBarrier {
  private fired = false;
  private promise: Promise<boolean> | null = null;
  private resolve: ((ok: boolean) => void) | null = null;
  private chainedResolve: ((ok: boolean) => void) | null = null;

  public arm(): void {
    this.fired = false;
    const chained = this.chainedResolve;
    this.chainedResolve = null;
    this.promise = new Promise((resolve) => {
      if (chained) {
        this.resolve = (ok: boolean) => {
          resolve(ok);
          chained(ok);
        };
      } else {
        this.resolve = resolve;
      }
    });
  }

  /** Mark the first chunk as observed. Returns true on the first call only. */
  public signal(): boolean {
    if (this.fired) return false;
    this.fired = true;
    if (this.resolve) {
      this.resolve(true);
      this.resolve = null;
    }
    return true;
  }

  public hasFired(): boolean {
    return this.fired;
  }

  public async wait(timeoutMs: number): Promise<boolean> {
    if (this.fired) return true;
    const pending = this.promise;
    if (!pending) return false;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void pending.then((ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
    });
  }

  /** ffmpeg is restarting; carry existing waiters to the next arm() cycle. */
  public chainRestart(): void {
    if (this.resolve) {
      this.chainedResolve = this.resolve;
    }
    this.resolve = null;
    this.promise = null;
  }

  /** ffmpeg is going down for good; resolve any pending waiters with false. */
  public abort(): void {
    if (this.resolve) {
      this.resolve(false);
    }
    this.resolve = null;
    this.promise = null;
  }
}
