export type SpotifyUnavailableLoopResult = {
  detected: boolean;
  count: number;
  distinctTracks: number;
  windowMs: number;
};

type UnavailableEvent = {
  trackId?: string | null;
  uri?: string | null;
  nowMs?: number;
};

type UnavailableWindowEntry = {
  at: number;
  key: string;
  unknown: boolean;
};

export class SpotifyUnavailableLoopGuard {
  private readonly windowMs: number;
  private readonly minEvents: number;
  private readonly minDistinctTracks: number;
  private events: UnavailableWindowEntry[] = [];

  constructor(options?: { windowMs?: number; minEvents?: number; minDistinctTracks?: number }) {
    this.windowMs = options?.windowMs ?? 10_000;
    this.minEvents = options?.minEvents ?? 3;
    this.minDistinctTracks = options?.minDistinctTracks ?? 3;
  }

  public recordUnavailable(event: UnavailableEvent): SpotifyUnavailableLoopResult {
    const now = event.nowMs ?? Date.now();
    const key = this.resolveTrackKey(event, now);
    this.events = this.events.filter((entry) => now - entry.at <= this.windowMs);
    this.events.push(key);

    const distinctTracks = new Set(
      this.events.filter((entry) => !entry.unknown).map((entry) => entry.key),
    ).size;
    const unknownCount = this.events.filter((entry) => entry.unknown).length;
    const detected =
      this.events.length >= this.minEvents &&
      (distinctTracks >= this.minDistinctTracks || unknownCount >= this.minEvents);

    const result = {
      detected,
      count: this.events.length,
      distinctTracks,
      windowMs: this.windowMs,
    };

    if (detected) {
      this.reset();
    }

    return result;
  }

  public markHealthyProgress(type: string, positionSec?: number): void {
    if (
      positionSec !== undefined &&
      positionSec > 0 &&
      (type === 'playing' || type === 'started' || type === 'position_correction')
    ) {
      this.reset();
    }
  }

  public reset(): void {
    this.events = [];
  }

  private resolveTrackKey(event: UnavailableEvent, now: number): UnavailableWindowEntry {
    const candidate = event.trackId || event.uri;
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return { at: now, key: candidate.trim(), unknown: false };
    }
    return { at: now, key: `unknown:${now}:${this.events.length}`, unknown: true };
  }
}
