import fs from 'fs';
import winston, { createLogger, format, transports, Logger } from 'winston';
import TransportStream from 'winston-transport';
import { EventEmitter } from 'events';

/**
 * -----------------------------------------------------------------------------
 * troxorLogger
 * -----------------------------------------------------------------------------
 * Unified Winston-based logger with live WebSocket broadcast support.
 * - Emits log messages to WebSocket clients via {@link logStreamEmitter}.
 * - Starts with safe default levels and later syncs with ConfigManager.
 * - Supports dynamic runtime level adjustments and persistent settings.
 * -----------------------------------------------------------------------------
 */

/* -------------------------------------------------------------------------- */
/*  Types & Interfaces                                                        */
/* -------------------------------------------------------------------------- */

interface LoggerExtensions {
  alert(message: string | object, meta?: Record<string, unknown>): void;
  setFileLogLevel(level: string): void;
  setConsoleLogLevel(level: string): void;
}

export type troxorLogger = Logger & LoggerExtensions;

/* -------------------------------------------------------------------------- */
/*  Real-Time Log Stream Emitter                                              */
/* -------------------------------------------------------------------------- */

export const logStreamEmitter = new EventEmitter();
logStreamEmitter.setMaxListeners(0);

/* -------------------------------------------------------------------------- */
/*  Log Levels & Formatting                                                   */
/* -------------------------------------------------------------------------- */

const logLevels = {
  error: 0,
  alert: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const logFormat = format.combine(
  format.errors({ stack: true }),
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  format.printf(({ timestamp, level, message, stack }) =>
    `[${timestamp}][${level}] ${stack || message}`,
  ),
);

/* -------------------------------------------------------------------------- */
/*  Lazy Runtime Access Helper                                                */
/* -------------------------------------------------------------------------- */

function safeGetConfig(path?: string): any | null {
  try {
    const { configManager } = require('../runtime/config');
    return configManager.get(path);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Custom Transport: WebSocket Notifications                                 */
/* -------------------------------------------------------------------------- */

class NotificationTransport extends TransportStream {
  log(info: any, callback: () => void): void {
    setImmediate(() => {
      try {
        const formatted =
          typeof info[Symbol.for('message')] === 'string'
            ? info[Symbol.for('message')]
            : String(info.message ?? '');
        const payload = {
          level: info.level ?? 'info',
          timestamp: info.timestamp ?? new Date().toISOString(),
          formatted,
        };
        logStreamEmitter.emit('log', payload);
      } catch {
        // ignore broadcast errors
      }
      callback(); // always after emit
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Default Startup Levels (safe fallback)                                    */
/* -------------------------------------------------------------------------- */

const defaultLevels = { consoleLevel: 'info', fileLevel: 'none' };

/* -------------------------------------------------------------------------- */
/*  Ensure log directory exists                                               */
/* -------------------------------------------------------------------------- */

if (!fs.existsSync('log')) {
  fs.mkdirSync('log', { recursive: true });
}

/* -------------------------------------------------------------------------- */
/*  Base Logger Initialization                                                */
/* -------------------------------------------------------------------------- */

const transportList: TransportStream[] = [
  new transports.Console({ level: defaultLevels.consoleLevel }),
  new NotificationTransport(),
];

if (defaultLevels.fileLevel !== 'none') {
  transportList.push(
    new transports.File({
      filename: 'log/loxone-audio-server.log',
      level: defaultLevels.fileLevel,
    }),
  );
}

const baseLogger = createLogger({
  levels: logLevels,
  level: 'debug',
  format: logFormat,
  transports: transportList,
});

/* -------------------------------------------------------------------------- */
/*  Runtime Loglevel Synchronization                                          */
/* -------------------------------------------------------------------------- */

/**
 * Attempts to apply log levels from runtime ConfigManager.
 * If config isn't ready, optionally retries once after a short delay.
 */
async function applyRuntimeConfigLevels(retry = true): Promise<boolean> {
  try {
    const { configManager } = require('../runtime/config');
    const cfg = configManager.get();
    if (!cfg?.logging) {
      throw new Error('Config not ready');
    }

    const { consoleLevel, fileLevel } = cfg.logging;
    logger.setConsoleLogLevel(consoleLevel);
    logger.setFileLogLevel(fileLevel);
    baseLogger.info(`[TroxorLogger] Applied runtime log levels (console=${consoleLevel}, file=${fileLevel})`);
    return true;
  } catch {
    if (retry) {
      setTimeout(() => void applyRuntimeConfigLevels(false), 2000);
    }
    return false;
  }
}

export { applyRuntimeConfigLevels };

/* -------------------------------------------------------------------------- */
/*  Persist Logging Config                                                    */
/* -------------------------------------------------------------------------- */

async function persistLoggingConfig(partial: { consoleLevel?: string; fileLevel?: string }): Promise<void> {
  try {
    const { configManager } = require('../runtime/config');
    const cfg = configManager.get();
    if (!cfg) {
      return;
    }

    const nextLogging = {
      consoleLevel: partial.consoleLevel ?? cfg.logging?.consoleLevel ?? 'info',
      fileLevel: partial.fileLevel ?? cfg.logging?.fileLevel ?? 'none',
    };

    configManager.update({ logging: nextLogging });
    await configManager.save();
    baseLogger.debug('[TroxorLogger] Updated persisted logging configuration');
  } catch {
    // swallow startup errors
  }
}

/* -------------------------------------------------------------------------- */
/*  Extensions: Custom Methods                                                */
/* -------------------------------------------------------------------------- */

const extensions: LoggerExtensions = {
  alert(message, meta) {
    if (typeof message === 'string') {
      baseLogger.log('alert', message, meta);
    } else {
      baseLogger.log('alert', JSON.stringify(message), meta);
    }
  },

  setConsoleLogLevel(level: string) {
    const consoleTransport = baseLogger.transports.find(
      (t): t is winston.transports.ConsoleTransportInstance =>
        t instanceof transports.Console,
    );
    if (consoleTransport) {
      consoleTransport.level = level;
      void persistLoggingConfig({ consoleLevel: level });
    }
  },

  setFileLogLevel(level: string) {
    const fileTransport = baseLogger.transports.find(
      (t): t is winston.transports.FileTransportInstance =>
        t instanceof transports.File,
    );
    if (fileTransport) {
      fileTransport.level = level;
      void persistLoggingConfig({ fileLevel: level });
    }
  },
};

/* -------------------------------------------------------------------------- */
/*  Final Export                                                              */
/* -------------------------------------------------------------------------- */

export const logger: troxorLogger = Object.assign(baseLogger, extensions);
export default logger;

/* -------------------------------------------------------------------------- */
/*  Automatic runtime recheck on startup                                      */
/* -------------------------------------------------------------------------- */

// Try to apply config levels when runtime comes online
void applyRuntimeConfigLevels(true);