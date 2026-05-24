import type { ZoneContext } from '@/application/zones/internal/zoneTypes';
import type { NotifierPort } from '@/ports/NotifierPort';

export type ZoneHeartbeatServiceDeps = {
  /** Returns a snapshot of all live zones. */
  listZones: () => ZoneContext[];
  /** Loxone state broadcaster. */
  notifier: Pick<NotifierPort, 'notifyZoneStateChanged'>;
};

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Periodically re-broadcasts each zone's last known state so Loxone
 * clients that joined mid-stream stay in sync. Idempotent: start() is
 * a no-op if already running.
 */
export class ZoneHeartbeatService {
  private readonly deps: ZoneHeartbeatServiceDeps;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: ZoneHeartbeatServiceDeps, intervalMs: number = DEFAULT_INTERVAL_MS) {
    this.deps = deps;
    this.intervalMs = intervalMs;
  }

  public start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  public stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const now = Date.now();
    for (const ctx of this.deps.listZones()) {
      if (!ctx.state) {
        continue;
      }
      ctx.lastZoneBroadcastAt = now;
      this.deps.notifier.notifyZoneStateChanged(ctx.state);
    }
  }
}
