import { createLogger } from '@/shared/logging/logger';
import { createRuntime } from '@/runtime/bootstrap';
import { registerShutdownHandlers } from '@/runtime/shutdown';

const runtime = createRuntime();

runtime
  .start()
  .then(() => registerShutdownHandlers(runtime))
  .catch((error) => {
    const log = createLogger('Server');
    const message = error instanceof Error ? error.message : String(error);
    log.error('fatal bootstrap error', { message });
    process.exit(1);
  });
