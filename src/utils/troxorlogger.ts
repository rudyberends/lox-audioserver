import winston, { Logger, LeveledLogMethod } from 'winston';
import Transport, { TransportStreamOptions } from 'winston-transport';
import { EventEmitter } from 'events';
import { getAdminConfig, updateAdminConfig } from '../config/config';

/**
 * Winston-based logger tailored for the Audio Server UI.
 * Carries custom levels, exposes helper methods to adjust runtime log levels,
 * and broadcasts log events to connected clients.
 */
interface TroxorLogger extends Logger {
  alert: LeveledLogMethod;
  setFileLogLevel(level: string): void;
  setConsoleLogLevel(level: string): void;
}

const LOG_LEVELS: Record<string, number> = {
  error: 0,
  alert: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/**
 * Unified formatter that tags each entry with a timestamp and level.
 */
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  winston.format.printf((info) => `[${info.timestamp}][${info.level}]${info.message}`),
);

/**
 * Shared emitter used by the websocket layer to stream live log updates.
 */
export const logStreamEmitter = new EventEmitter();
logStreamEmitter.setMaxListeners(0);

/**
 * Winston transport that forwards log records through {@link logStreamEmitter}.
 * Keeps UI clients in sync without affecting the primary logging pipeline.
 */
class NotificationTransport extends Transport {
  name: string;

  constructor(opts?: TransportStreamOptions) {
    super(opts);
    this.name = 'NotificationTransport';
  }

  log(info: any, callback: () => void) {
    setImmediate(() => {
      this.emit('logged', info);
      try {
        const formatted = typeof info[Symbol.for('message')] === 'string'
          ? info[Symbol.for('message')]
          : typeof info.message === 'string'
            ? info.message
            : '';
        const payload = {
          level: info.level || 'info',
          timestamp: info.timestamp || new Date().toISOString(),
          formatted,
        };
        logStreamEmitter.emit('log', payload);
      } catch (error) {
        // If broadcasting fails we silently ignore so logging continues unaffected.
      }
    });
    callback();
  }
}

const notificationTransport = new NotificationTransport();

/**
 * Reads persisted admin preferences and returns the startup log levels.
 */
function getInitialLogLevels() {
  const admin = getAdminConfig();
  const consoleLevel = admin.logging?.consoleLevel || 'info';
  const fileLevel = admin.logging?.fileLevel || 'none';
  return { consoleLevel, fileLevel };
}

const loggerConfig = getInitialLogLevels();

const logger = winston.createLogger({
  level: 'debug',
  levels: LOG_LEVELS,
  format: logFormat,
  transports: [
    new winston.transports.Console({ level: loggerConfig.consoleLevel }),
    new winston.transports.File({
      filename: 'log/loxone-audio-server.log',
      level: loggerConfig.fileLevel,
    }),
    notificationTransport,
  ] as winston.transport[],
}) as unknown as TroxorLogger;

/**
 * Convenience helper that mirrors {@code logger.error} but maps onto the custom `alert` level.
 */
logger.alert = ((message: string | object, meta?: any) => {
  if (typeof message === 'string') {
    logger.log('alert', message, meta);
  } else {
    logger.log('alert', '', message);
  }
}) as LeveledLogMethod;

/**
 * Updates the file transport's level and persists the selection.
 */
logger.setFileLogLevel = (level: string) => {
  const fileTransport = logger.transports.find((t) => t instanceof winston.transports.File);
  if (fileTransport) {
    fileTransport.level = level;
    persistLoggingConfig({ fileLevel: level });
  }
};

/**
 * Updates the console transport's level and persists the selection.
 */
logger.setConsoleLogLevel = (level: string) => {
  const consoleTransport = logger.transports.find((t) => t instanceof winston.transports.Console);
  if (consoleTransport) {
    consoleTransport.level = level;
    persistLoggingConfig({ consoleLevel: level });
  }
};

/**
 * Persists partial logging preferences while keeping existing settings intact.
 */
function persistLoggingConfig(partial: { consoleLevel?: string; fileLevel?: string }) {
  const current = getAdminConfig();
  const logging = {
    consoleLevel: partial.consoleLevel ?? current.logging?.consoleLevel ?? 'info',
    fileLevel: partial.fileLevel ?? current.logging?.fileLevel ?? 'none',
  };

  updateAdminConfig({
    ...current,
    logging,
  });
}

export default logger;
