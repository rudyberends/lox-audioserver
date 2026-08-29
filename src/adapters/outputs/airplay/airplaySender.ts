/**
 * The seam between an AirPlay zone output and the protocol that drives the
 * device.
 *
 * Keeping this interface exactly as wide as the output actually needs is the
 * point: the output drives a device without knowing which protocol reaches it.
 * Today that is always node-airplay, which chooses its own lane per receiver;
 * the seam is what made replacing the previous native sender a swap rather than
 * a rewrite, and what will make the next one the same.
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

