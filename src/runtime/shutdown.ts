import { createLogger } from '@/shared/logging/logger';
import type { Runtime } from '@/runtime/bootstrap';

export function registerShutdownHandlers(
  runtime: Runtime,
  log = createLogger('Server'),
): void {
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    // Force-exit watchdog so Ctrl+C cannot hang forever if a service stop never resolves.
    const forceExit = setTimeout(() => {
      log.warn('shutdown timed out; forcing exit');
      process.exit(1);
    }, 8000);

    await runtime.stop();

    clearTimeout(forceExit);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Without these handlers Node 22+ aborts the process on the first stray
  // rejection or async throw — which on this audio bridge means a single
  // dropped promise from any provider can kill all zones. We log and keep
  // running for rejections; uncaught exceptions still escalate to graceful
  // shutdown because V8 state can be inconsistent after one.
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    log.error('unhandled promise rejection', { message, stack });
  });

  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    void shutdown();
  });
}
