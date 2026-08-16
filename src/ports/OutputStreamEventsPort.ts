export type OutputStreamRequestEvent = {
  zoneId: number;
  streamId: string;
  url: string;
  remoteAddress?: string | null;
};

export type OutputStreamRequestOptions = {
  zoneId: number;
  host?: string;
  timeoutMs: number;
  /**
   * Ignore a remembered request older than this epoch-ms mark. Without it the recent-request
   * memory can answer with the *previous* track's fetch and so confirm a renderer that never
   * pulled this one.
   */
  notBefore?: number;
};

export interface OutputStreamEventsPort {
  waitForStreamRequest: (
    options: OutputStreamRequestOptions,
  ) => Promise<OutputStreamRequestEvent | null>;
}
