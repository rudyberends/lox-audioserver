import winston, { Logger, LeveledLogMethod } from 'winston';
import Transport, { TransportStreamOptions } from 'winston-transport';
import { EventEmitter } from 'events';
import { getAdminConfig, updateAdminConfig } from '../config/config';

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

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  winston.format.printf((info) => `[${info.timestamp}][${info.level}]${info.message}`),
);

export const logStreamEmitter = new EventEmitter();
logStreamEmitter.setMaxListeners(0);

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

logger.alert = ((message: string | object, meta?: any) => {
  if (typeof message === 'string') {
    logger.log('alert', message, meta);
  } else {
    logger.log('alert', '', message);
  }
}) as LeveledLogMethod;

logger.setFileLogLevel = (level: string) => {
  const fileTransport = logger.transports.find((t) => t instanceof winston.transports.File);
  if (fileTransport) {
    fileTransport.level = level;
    persistLoggingConfig({ fileLevel: level });
  }
};

logger.setConsoleLogLevel = (level: string) => {
  const consoleTransport = logger.transports.find((t) => t instanceof winston.transports.Console);
  if (consoleTransport) {
    consoleTransport.level = level;
    persistLoggingConfig({ consoleLevel: level });
  }
};

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
