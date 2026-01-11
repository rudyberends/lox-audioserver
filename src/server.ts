import { loadConfig } from '@/config';
import { createLogger, logManager } from '@/core/logging/logger';
import { HttpService } from '@/modules/http';
import { contentManager } from '@/modules/content/contentManager';
import { LoxoneHttpService } from '@/modules/loxone/http';
import { zoneManager } from '@/modules/zones/zoneManager';
import { loadConfig as loadStoredConfig } from '@/domain/config/configStore';

/**
 * Descriptor for services that need graceful shutdown coordination.
 */
type LifecycleService = {
  name: string;
  stop: () => Promise<void>;
};

let httpService: HttpService | null = null;
let loxoneService: LoxoneHttpService | null = null;
let shutdownHandlersRegistered = false;
let restartInFlight = false;

async function handleReinitialize(): Promise<boolean> {
  const log = createLogger('Server');
  if (restartInFlight) {
    log.warn('restart already in progress; ignoring reinitialize request');
    return false;
  }
  restartInFlight = true;
  try {
    log.info('light reinitialize requested');
    const cfg = await loadStoredConfig();
    await contentManager.reinitialize();
    await zoneManager.replaceAll(cfg.zones ?? [], cfg.inputs ?? null);
    log.info('light reinitialize complete');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('light reinitialize failed', { message });
    return false;
  } finally {
    restartInFlight = false;
  }
}

async function startServices(): Promise<void> {
  const storedConfig = await loadStoredConfig();
  const config = loadConfig(storedConfig.system?.audioserver?.macId);
  const logLevel = storedConfig.system?.logging?.consoleLevel ?? config.env.logLevel;
  logManager.configure({ level: logLevel });
  const log = createLogger('Server');

  log.info('bootstrapping audio server', {
    env: config.env.nodeEnv,
  });

  await zoneManager.initialize();
  await contentManager.reinitialize();

  httpService = new HttpService(config.http, { onReinitialize: handleReinitialize });
  loxoneService = new LoxoneHttpService(config.loxone, {
    host: config.env.hostname,
    onRestart: handleSoftRestart,
  });

  await httpService.start();
  await loxoneService.start();

  if (!shutdownHandlersRegistered) {
    registerShutdownHandlers(log);
    shutdownHandlersRegistered = true;
  }

  log.info('startup complete');
}

async function stopServices(): Promise<void> {
  const log = createLogger('Server');
  const services: LifecycleService[] = [
    { name: 'zones', stop: () => zoneManager.shutdown() },
  ];

  if (loxoneService) {
    services.push({ name: 'loxone', stop: () => loxoneService!.stop() });
  }
  if (httpService) {
    services.push({ name: 'http', stop: () => httpService!.stop() });
  }

  await Promise.all(
    services.map((service) =>
      stopWithTimeout(service.name, service.stop, 6000, log),
    ),
  );

  httpService = null;
  loxoneService = null;
}

async function handleSoftRestart(): Promise<boolean> {
  const log = createLogger('Server');
  if (restartInFlight) {
    log.warn('restart already in progress; ignoring duplicate request');
    return false;
  }
  restartInFlight = true;
  try {
    log.info('soft restart requested');
    await stopServices();
    await startServices();
    log.info('soft restart complete');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('soft restart failed', { message });
    return false;
  } finally {
    restartInFlight = false;
  }
}

async function stopWithTimeout(
  name: string,
  stopFn: () => Promise<void>,
  timeoutMs: number,
  log = createLogger('Server'),
): Promise<void> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => {
      log.warn(`service ${name} stop timed out`, { timeoutMs });
      resolve();
    }, timeoutMs);
  });

  try {
    await Promise.race([stopFn(), timeoutPromise]);
    log.info(`service ${name} stopped`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`failed to stop ${name}`, { message });
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function registerShutdownHandlers(log = createLogger('Server')): void {
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

    await stopServices();

    clearTimeout(forceExit);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startServices().catch((error) => {
  const log = createLogger('Server');
  const message = error instanceof Error ? error.message : String(error);
  log.error('fatal bootstrap error', { message });
  process.exit(1);
});
