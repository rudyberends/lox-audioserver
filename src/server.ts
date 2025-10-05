import logger from './utils/troxorlogger';
import { initializeConfig, config } from './config/config';
import { startWebServer } from './http/webserver';
import { cleanupZones } from './backend/zone/zonemanager';

const enum ServerNames {
  AppHttp = 'AppHttp',
  MsHttp = 'msHttp',
}

type ServerHandle = { shutdown: () => Promise<void> };

const serverHandles = new Map<ServerNames, ServerHandle>();
let shuttingDown = false;

function validateEnvVariables() {
  const missing: string[] = [];

  if (!config.audioserver?.name) missing.push('AudioServer name');

  if (missing.length > 0) {
    throw new Error(`Missing configuration values: ${missing.join(', ')}`);
  }
}

/**
 * Initialize the application by loading the configuration and validating necessary variables.
 * @throws Will throw an error if the configuration is invalid.
 */
async function initializeAudioServer() {
  await initializeConfig(); // Load configuration from the environment
  validateEnvVariables(); // Validate the loaded configuration
  logger.info('[Main] Starting Loxone Audio Server Proxy');
  logger.info(`[Main] AudioServer Name: ${config.audioserver!.name}`); // Logging AudioServer name safely
}

/**
 * Start the web servers for the audio server proxy.
 */
function startWebServers() {
  const appServer = startWebServer(7091, ServerNames.AppHttp);
  serverHandles.set(ServerNames.AppHttp, appServer);
  logger.info(`[Main] ${ServerNames.AppHttp} server started on port 7091.`);

  const msServer = startWebServer(7095, ServerNames.MsHttp);
  serverHandles.set(ServerNames.MsHttp, msServer);
  logger.info(`[Main] ${ServerNames.MsHttp} server started on port 7095.`);
}

/**
 * Handle graceful shutdown of the application.
 * @param {string} signal - The signal received for shutdown (e.g., SIGINT, SIGTERM).
 */
async function handleShutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    logger.warn(`[Main] Shutdown already in progress (signal: ${signal}).`);
    return;
  }
  shuttingDown = true;

  logger.info(`[Main] Received shutdown signal: ${signal}. Shutting down gracefully.`);
  try {
    await cleanupZones();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[Main] Error during zone cleanup: ${message}`);
  }

  const shutdownOperations = Array.from(serverHandles.entries()).map(([name, handle]) =>
    handle
      .shutdown()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[Main] Error shutting down ${name}: ${message}`);
      }),
  );

  await Promise.allSettled(shutdownOperations);

  process.exit(0);
}

/**
 * Main function to start the application.
 * Initializes configuration, sets up zones, and starts the servers.
 */
async function startApplication() {
  try {
    await initializeAudioServer(); // Initialize application configuration
    startWebServers(); // Start the web servers
  } catch (error: unknown) {
    // Check if error is an instance of Error for type safety
    if (error instanceof Error) {
      logger.error('[Main] Error during initialization or setup:', error.message); // Log the error message
    } else {
      logger.error('[Main] Unknown error during initialization or setup.'); // Handle unknown errors
    }
    process.exit(1); // Exit the process with a failure code
  }
}

const shutdownSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
shutdownSignals.forEach((signal) => {
  process.on(signal, () => {
    void handleShutdown(signal);
  });
});

// Start the application
startApplication();
