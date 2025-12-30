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

export const streamEvents = new EventEmitter();
const recentRequests = new Map<string, StreamRequestSnapshot>();
const RECENT_WINDOW_MS = 45000;

export function normalizeRemoteAddress(address?: string | null): string {
  if (!address) return '';
  if (address.startsWith('::ffff:')) {
    return address.slice(7);
  }
  if (address === '::1') return '127.0.0.1';
  return address;
}

export function recordStreamRequest(event: StreamRequestEvent): void {
  const normalizedHost = normalizeRemoteAddress(event.remoteAddress).toLowerCase();
  const snapshot: StreamRequestSnapshot = {
    ...event,
    remoteAddress: event.remoteAddress ?? null,
    timestamp: Date.now(),
    normalizedHost,
  };
  const hostKey = normalizedHost || '*';
  recentRequests.set(`${event.zoneId}|${hostKey}`, snapshot);
  recentRequests.set(`${event.zoneId}|*`, snapshot);
  streamEvents.emit('stream-request', event);
}

export async function waitForStreamRequest(options: {
  zoneId: number;
  host?: string;
  timeoutMs: number;
}): Promise<StreamRequestEvent | null> {
  const { zoneId, host, timeoutMs } = options;
  const normalizedHost = host?.trim().toLowerCase() ?? '';
  const now = Date.now();
  const key = `${zoneId}|${normalizedHost || '*'}`;
  const cached = recentRequests.get(key);
  if (cached && now - cached.timestamp <= RECENT_WINDOW_MS) {
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
      streamEvents.off('stream-request', handler);
    };

    streamEvents.on('stream-request', handler);
  });
}
