import { loadConfig } from '@/config';
import { createLogger, logManager } from '@/core/logging/logger';
import { HttpService } from '@/modules/http';
import { contentManager } from '@/modules/content/contentManager';
import { LoxoneHttpService } from '@/modules/loxone/http';
import { zoneManager } from '@/modules/zones/zoneManager';
import { loadConfig as loadStoredConfig } from '@/domain/config/configStore';
import type { AudioServerConfig } from '@/domain/config/types';
import { lineInMetadataService } from '@/modules/audio/inputs/linein/lineInMetadataService';

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
  lineInMetadataService.start();

  httpService = new HttpService(config.http, { onReinitialize: handleReinitialize });
  loxoneService = new LoxoneHttpService(config.loxone, {
    host: config.env.hostname,
    onRestart: handleSoftRestart,
  });

  await httpService.start();
  await loxoneService.start();
  await notifyMiniserverStartup(storedConfig);

  if (!shutdownHandlersRegistered) {
    registerShutdownHandlers(log);
    shutdownHandlersRegistered = true;
  }

  log.info('startup complete');
}

async function notifyMiniserverStartup(config: AudioServerConfig): Promise<void> {
  const log = createLogger('Server');
  const miniserverIp = config.system?.miniserver?.ip?.trim();
  const macId = config.system?.audioserver?.macId?.trim().toUpperCase();

  if (!miniserverIp || !macId) {
    log.debug('miniserver startup ping skipped (missing ip/mac)');
    return;
  }

  const section = findServerSection(config.rawAudioConfig?.raw, macId)
    ?? findServerSection(config.rawAudioConfig?.rawString, macId);
  const uuid = normalizeString(section?.uuid);

  if (!uuid) {
    log.debug('miniserver startup ping skipped (missing uuid)', { macId });
    return;
  }

  const url = `http://${miniserverIp}/dev/sps/devicestartup/${encodeURIComponent(uuid)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!response.ok) {
      log.warn('miniserver startup ping failed', { status: response.status, url });
    } else {
      log.info('miniserver startup ping sent', { url });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('miniserver startup ping failed', { message, url });
  } finally {
    clearTimeout(timeout);
  }
}

function findServerSection(raw: unknown, macId: string): Record<string, any> | undefined {
  if (!raw || !macId) {
    return undefined;
  }

  const normalizedMacId = macId.trim().toUpperCase();
  let parsed = raw;

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }

  if (!Array.isArray(parsed)) {
    return undefined;
  }

  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const matchKey = Object.keys(entry).find(
      (key) => key.trim().toUpperCase() === normalizedMacId,
    );
    if (matchKey) {
      return (entry as Record<string, any>)[matchKey] as Record<string, any>;
    }
  }

  return undefined;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

async function stopServices(): Promise<void> {
  const log = createLogger('Server');
  const services: LifecycleService[] = [
    { name: 'zones', stop: () => zoneManager.shutdown() },
  ];
  services.push({ name: 'linein-metadata', stop: async () => lineInMetadataService.stop() });

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
