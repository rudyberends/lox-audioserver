import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * A locally-served stream proxy route registered on the shared HTTP gateway
 * (:7090). Content providers expose one of these instead of spinning up their
 * own ephemeral `http.Server`; the gateway matches by path prefix, enforces the
 * local-client guard, and turns thrown errors into a 500 before dispatching.
 */
export interface StreamProxyRoute {
  /** True when this route should handle the given (query-stripped) pathname. */
  matches(pathname: string): boolean;
  /** Serve the proxied stream. Thrown errors are turned into a 500 by the gateway. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

/**
 * Default lifetime for a proxy session before it becomes eligible for pruning.
 * Comfortably longer than the gap between creating a session and ffmpeg pulling
 * it, so a live stream is never evicted out from under itself.
 */
export const PROXY_SESSION_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Evict proxy sessions older than `maxAgeMs` from `sessions`. Keeps the shared
 * gateway from accumulating sessions that were created but never (fully)
 * consumed — e.g. when playback is aborted before ffmpeg connects. Call it lazily
 * whenever a new session is created. Returns the number of entries evicted.
 */
export function pruneExpiredSessions<T extends { createdAt: number }>(
  sessions: Map<string, T>,
  maxAgeMs: number = PROXY_SESSION_MAX_AGE_MS,
): number {
  const cutoff = Date.now() - maxAgeMs;
  let evicted = 0;
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff) {
      sessions.delete(id);
      evicted += 1;
    }
  }
  return evicted;
}
