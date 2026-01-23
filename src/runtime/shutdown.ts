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
}
