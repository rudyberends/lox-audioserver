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
};

export interface OutputStreamEventsPort {
  waitForStreamRequest: (
    options: OutputStreamRequestOptions,
  ) => Promise<OutputStreamRequestEvent | null>;
}
