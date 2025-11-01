/**
 * Application Entry Point
 * -----------------------
 * Bootstraps the Loxone AudioServer runtime and handles graceful shutdown.
 */

import logger from '@/utils/troxorLogger';
import { systemRuntime } from './runtime';

let isShuttingDown = false;

/**
 * Starts the AudioServer runtime.
 */
async function startApplication(): Promise<void> {
  try {
    logger.info('[main] Starting Loxone AudioServer runtime...');
    await systemRuntime.initialize();
    logger.info('[main] Initialization complete.');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`[main] Startup failed: ${msg}`);
    process.exit(1);
  }
}

/**
 * Handles OS termination signals gracefully.
 */
async function handleShutdown(signal?: NodeJS.Signals): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  if (signal) {
    logger.info(`[main] Received ${signal}. Starting graceful shutdown...`);
  }

  let hadError = false;
  try {
    await systemRuntime.shutdown();
    logger.info('[main] Shutdown complete.');
  } catch (error) {
    hadError = true;
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[main] Error during shutdown: ${msg}`);
  } finally {
    setTimeout(() => process.exit(hadError ? 1 : 0), 1000);
  }
}

// Register termination signals
(['SIGINT', 'SIGTERM'] as const).forEach((signal) =>
  process.on(signal, () => void handleShutdown(signal)),
);

// Kick off the runtime
void startApplication();