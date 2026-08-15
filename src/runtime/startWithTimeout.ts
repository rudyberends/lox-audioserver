import { createLogger } from '@/shared/logging/logger';

/**
 * Starts a subsystem the server can live without, bounded in time.
 *
 * The counterpart of {@link stopWithTimeout}, and for the same reason: readiness is the last
 * statement of the startup sequence, so every step before it has to settle before the server
 * can say it is ready. A start that never settles pins the phase on `starting` forever —
 * node-upnp 0.3.0 awaited a dgram bind callback that only fires on success, so a host with
 * :1900 already taken left `/ready` answering 503 on a server that served zones and played
 * music the whole time.
 *
 * The cure is not to swallow more errors. A start that *fails* already unwinds into
 * `markFailed`, and "failed, here is why" is a verdict a supervisor can act on. A promise
 * that never settles is the one state with no verdict at all, so this bounds the wait and
 * rethrows errors exactly as before.
 *
 * The abandoned start keeps running: a subsystem that binds its socket ten seconds late is
 * still worth having, and there is no generic way to cancel one. It logs when it settles, so
 * a timeout that was merely a slow Pi is distinguishable from one that never came back.
 */
export async function startWithTimeout(
  name: string,
  startFn: () => Promise<void>,
  timeoutMs: number,
  log = createLogger('Server'),
): Promise<void> {
  type Outcome = { kind: 'started' } | { kind: 'timeout' } | { kind: 'error'; error: unknown };

  let timeoutHandle: NodeJS.Timeout | null = null;
  // Never rejects, so abandoning it after a timeout cannot raise an unhandled rejection.
  const startPromise = (async (): Promise<Outcome> => {
    try {
      await startFn();
      return { kind: 'started' };
    } catch (error) {
      return { kind: 'error', error };
    }
  })();
  const timeoutPromise = new Promise<Outcome>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
  });

  const result = await Promise.race([startPromise, timeoutPromise]).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  });

  if (result.kind === 'error') {
    throw result.error;
  }

  if (result.kind === 'timeout') {
    log.warn(`service ${name} start timed out; continuing without it`, { timeoutMs });
    void startPromise.then((finalResult) => {
      if (finalResult.kind === 'started') {
        log.info(`service ${name} started after its timeout`, { timeoutMs });
        return;
      }
      if (finalResult.kind === 'error') {
        const message =
          finalResult.error instanceof Error ? finalResult.error.message : String(finalResult.error);
        log.error(`failed to start ${name}`, { message });
      }
    });
  }
}
