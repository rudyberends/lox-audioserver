/**
 * Spotify refusing a stored credentials blob, in every wording librespot reports it.
 *
 * It surfaces three ways for the same underlying refusal: as a thrown session error, as a
 * `spirc start failed` message when a Connect device logs in, and — the one that loops — as a
 * per-track `Unable to load audio item` on the native log channel. Callers treat all three the
 * same: the blob is dead, and replaying it will never start working.
 */
export function isCredentialRejection(message: string | null | undefined): boolean {
  const raw = (message ?? '').toLowerCase();
  if (!raw) {
    return false;
  }
  return (
    raw.includes('invalid_credentials') ||
    raw.includes('badcredentials') ||
    raw.includes('bad_credentials') ||
    raw.includes('login request was denied')
  );
}

/** Thrown instead of returning null, so a caller can re-mint rather than retry the same blob. */
export class LibrespotCredentialsRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibrespotCredentialsRejected';
  }
}

export type SpotifyUnavailableLoopResult = {
  detected: boolean;
  count: number;
  distinctTracks: number;
  /** Highest number of events the window holds for a single track. */
  sameTrackRepeats: number;
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
  private readonly minSameTrackRepeats: number;
  private events: UnavailableWindowEntry[] = [];

  constructor(options?: {
    windowMs?: number;
    minEvents?: number;
    minDistinctTracks?: number;
    minSameTrackRepeats?: number;
  }) {
    this.windowMs = options?.windowMs ?? 10_000;
    this.minEvents = options?.minEvents ?? 3;
    this.minDistinctTracks = options?.minDistinctTracks ?? 3;
    /*
     * A handful of failures on ONE track is not a loop — that is a track which is genuinely
     * unavailable in this market, and skipping past it is the correct outcome. So the distinct-track
     * rule deliberately ignores repeats (see the test that pins it).
     *
     * What it could not see is volume. In #333 an account whose stored credentials Spotify refused
     * produced the same track ~540 times in six seconds: distinctTracks stayed at 1 forever, nothing
     * ever fired, and the error spam pushed every useful line out of the log buffer. Repeats past
     * this count are no longer a verdict about the track, they are a spin.
     */
    this.minSameTrackRepeats = options?.minSameTrackRepeats ?? 12;
  }

  public recordUnavailable(event: UnavailableEvent): SpotifyUnavailableLoopResult {
    const now = event.nowMs ?? Date.now();
    const key = this.resolveTrackKey(event, now);
    this.events = this.events.filter((entry) => now - entry.at <= this.windowMs);
    this.events.push(key);

    const known = this.events.filter((entry) => !entry.unknown);
    const distinctTracks = new Set(known.map((entry) => entry.key)).size;
    const unknownCount = this.events.length - known.length;
    const repeatsByTrack = new Map<string, number>();
    for (const entry of known) {
      repeatsByTrack.set(entry.key, (repeatsByTrack.get(entry.key) ?? 0) + 1);
    }
    const sameTrackRepeats = Math.max(0, ...repeatsByTrack.values());
    const detected =
      this.events.length >= this.minEvents &&
      (distinctTracks >= this.minDistinctTracks ||
        unknownCount >= this.minEvents ||
        sameTrackRepeats >= this.minSameTrackRepeats);

    const result = {
      detected,
      count: this.events.length,
      distinctTracks,
      sameTrackRepeats,
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
