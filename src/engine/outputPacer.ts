export interface PacerSignals {
  hasBackpressure(): boolean;
  subscriberCount(): number;
}

export interface PacerUpstream {
  pause(): void;
  resume(): void;
}

export interface PacerLogger {
  spam(message: string, context?: Record<string, unknown>): void;
}

/**
 * Wall-clock pacing for ffmpeg output. Only active when the input lacks `-re`
 * pacing (currently: URL sources with `realTime=false`). Without this the
 * encoder can race ahead of the wall clock on finite sources (Apple Music MP4)
 * and exit prematurely while pull-based outputs (Cast) still expect a live
 * stream. The pacer pauses ffmpeg stdout when the lead buffer exceeds
 * `maxAheadBytes` and resumes once the wall clock catches up.
 */
export class OutputPacer {
  private paused = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly bytesPerSec: number,
    private readonly maxAheadBytes: number,
    private readonly signals: PacerSignals,
    private readonly upstream: PacerUpstream,
    private readonly log: PacerLogger,
    private readonly logContext: Record<string, unknown>,
  ) {}

  public get enabled(): boolean {
    return this.bytesPerSec > 0 && this.maxAheadBytes > 0;
  }

  public reset(): void {
    this.clearTimer();
    this.paused = false;
  }

  public tick(totalBytes: number, startTs: number | null): void {
    if (!this.enabled) return;
    if (startTs == null) return;
    if (this.signals.hasBackpressure()) return;

    const now = Date.now();
    const elapsedMs = Math.max(0, now - startTs);
    const expectedBytes = (this.bytesPerSec * elapsedMs) / 1000;
    const allowedBytes = expectedBytes + this.maxAheadBytes;
    const overshoot = totalBytes - allowedBytes;

    if (overshoot > 0) {
      if (!this.paused) {
        this.paused = true;
        this.log.spam('ffmpeg output pacing pause', {
          ...this.logContext,
          overshootBytes: Math.round(overshoot),
          maxAheadBytes: this.maxAheadBytes,
          subscribers: this.signals.subscriberCount(),
        });
      }
      this.upstream.pause();

      // Resume when wall clock catches up. Stay paused if no subscribers are present.
      const waitMs = Math.min(15_000, Math.max(5, Math.ceil((overshoot / this.bytesPerSec) * 1000)));
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          if (this.signals.subscriberCount() === 0) {
            return;
          }
          this.paused = false;
          this.log.spam('ffmpeg output pacing resume', this.logContext);
          this.upstream.resume();
        }, waitMs);
        this.timer.unref();
      }
      return;
    }

    if (this.paused && this.signals.subscriberCount() > 0) {
      this.paused = false;
      this.log.spam('ffmpeg output pacing resume', this.logContext);
      this.clearTimer();
      this.upstream.resume();
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
