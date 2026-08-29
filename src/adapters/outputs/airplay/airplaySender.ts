/**
 * The seam between an AirPlay zone output and the protocol that drives the
 * device.
 *
 * There are two implementations and they speak different protocols to the same
 * speakers: {@link RaopSender} does AirPlay 1 (RAOP) through node-libraop, and
 * `Ap2Sender` does AirPlay 2 through node-airplay. Which one a zone uses is a
 * per-output setting, because the answer is not the same for every device —
 * Apple receivers on OS 27 no longer render AirPlay 1 at all, while plenty of
 * third-party gear has years of proven mileage on it.
 *
 * Keeping this interface exactly as wide as the output actually needs is the
 * point: it is what lets both live side by side without the output knowing
 * which one it holds.
 */
export interface AirplaySender {
  /** Connect (if needed) and feed PCM from `source`. */
  start(source: NodeJS.ReadableStream, volume: number): Promise<boolean>;

  /**
   * Start as a member of a sync group, anchored to a shared NTP instant so
   * every member renders the same frame at the same wall-clock moment.
   */
  startForGroup(
    source: NodeJS.ReadableStream,
    volume: number,
    basePlayNtp: bigint,
    reAnchor: boolean,
  ): Promise<boolean>;

  /** Tear the session down. */
  stop(): void;

  pause(): void;
  resume(source: NodeJS.ReadableStream): void;

  /** Volume as 0-100; the implementation maps it onto the protocol's scale. */
  setVolume(volume: number): Promise<void>;

  /** Swap the PCM source without dropping the session (track change). */
  rebind(source: NodeJS.ReadableStream): void;

  updateMetadata(payload: {
    title?: string;
    artist?: string;
    album?: string;
    cover?: { data: Buffer; mime?: string };
    elapsedMs?: number;
    durationMs?: number;
  }): void;

  setProgress(elapsedMs: number, durationMs: number): void;

  isRunning(): boolean;

  /** Device read-ahead in ms — what the zone clock has to account for. */
  getLatencyMs(): number;
}

/** Which protocol an AirPlay output drives its device with. */
export type AirplayProtocol = 'airplay1' | 'airplay2';

/**
 * Read the per-output protocol choice. Unset stays on AirPlay 1: switching a
 * working zone is the user's call, not a silent upgrade.
 */
export function parseAirplayProtocol(value: unknown): AirplayProtocol {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === 'airplay2' || text === 'ap2' || text === '2') {
    return 'airplay2';
  }
  return 'airplay1';
}
