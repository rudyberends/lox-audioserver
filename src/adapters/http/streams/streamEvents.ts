import { EventEmitter } from 'node:events';

export type StreamRequestEvent = {
  zoneId: number;
  streamId: string;
  url: string;
  remoteAddress?: string | null;
};

type StreamRequestSnapshot = StreamRequestEvent & {
  timestamp: number;
  normalizedHost: string;
};

const RECENT_WINDOW_MS = 45000;

export function normalizeRemoteAddress(address?: string | null): string {
  if (!address) return '';
  if (address.startsWith('::ffff:')) {
    return address.slice(7);
  }
  if (address === '::1') return '127.0.0.1';
  return address;
}

export class StreamEvents {
  private readonly events = new EventEmitter();
  private readonly recentRequests = new Map<string, StreamRequestSnapshot>();
  private readonly recentWindowMs: number;

  constructor(options?: { recentWindowMs?: number }) {
    this.recentWindowMs = options?.recentWindowMs ?? RECENT_WINDOW_MS;
  }

  public recordStreamRequest(event: StreamRequestEvent): void {
    const normalizedHost = normalizeRemoteAddress(event.remoteAddress).toLowerCase();
    const snapshot: StreamRequestSnapshot = {
      ...event,
      remoteAddress: event.remoteAddress ?? null,
      timestamp: Date.now(),
      normalizedHost,
    };
    const hostKey = normalizedHost || '*';
    this.recentRequests.set(`${event.zoneId}|${hostKey}`, snapshot);
    this.recentRequests.set(`${event.zoneId}|*`, snapshot);
    this.events.emit('stream-request', event);
  }

  public async waitForStreamRequest(options: {
    zoneId: number;
    host?: string;
    timeoutMs: number;
    notBefore?: number;
  }): Promise<StreamRequestEvent | null> {
    const { zoneId, host, timeoutMs, notBefore } = options;
    const normalizedHost = host?.trim().toLowerCase() ?? '';
    const now = Date.now();
    const key = `${zoneId}|${normalizedHost || '*'}`;
    const cached = this.recentRequests.get(key);
    // `notBefore` is what makes this usable as a per-track readiness check: the remembered
    // request must postdate the moment the caller handed the renderer its URI, or the previous
    // track's fetch would answer for this one.
    if (
      cached &&
      now - cached.timestamp <= this.recentWindowMs &&
      (notBefore === undefined || cached.timestamp >= notBefore)
    ) {
      return cached;
    }

    return await new Promise((resolve) => {
      const handler = (event: StreamRequestEvent) => {
        if (event.zoneId !== zoneId) return;
        const remote = normalizeRemoteAddress(event.remoteAddress).toLowerCase();
        if (normalizedHost && remote && remote !== normalizedHost) {
          return;
        }
        cleanup();
        resolve(event);
      };

      const timeout = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
      timeout.unref();

      const cleanup = () => {
        clearTimeout(timeout);
        this.events.off('stream-request', handler);
      };

      this.events.on('stream-request', handler);
    });
  }
}
