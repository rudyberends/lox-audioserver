import { logBuffer } from '@/shared/logging/logBuffer';
import type { LogLevel } from '@/types/logLevel';

/**
 * Minimal structured logger with hierarchical scopes and optional JSON output.
 * `spam` is below debug for very noisy traces.
 */
export type { LogLevel } from '@/types/logLevel';

const WEIGHTS: Record<LogLevel, number> = {
  spam: 5,
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  none: 100,
};

interface LoggerConfig {
  level: LogLevel;
  json: boolean;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export interface LoggerOptions {
  level?: LogLevel;
  json?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export type LogContext = Record<string, unknown>;

class LogManager {
  private readonly config: LoggerConfig = {
    level: 'info',
    json: false,
    stdout: process.stdout,
    stderr: process.stderr,
  };

  public configure(options: LoggerOptions): void {
    this.config.level = options.level ?? this.config.level;
    this.config.json = options.json ?? this.config.json;
    this.config.stdout = options.stdout ?? this.config.stdout;
    this.config.stderr = options.stderr ?? this.config.stderr;
  }

  public create(component: string, ...scopes: string[]): ComponentLogger {
    return new ComponentLogger(this.config, [component, ...scopes]);
  }
}

export const logManager = new LogManager();

/**
 * Creates a scoped logger using the global configuration.
 */
export function createLogger(component: string, ...scopes: string[]): ComponentLogger {
  return logManager.create(component, ...scopes);
}

/**
 * Logger instance bound to a set of scopes (component names).
 */
export class ComponentLogger {
  constructor(
    private readonly config: LoggerConfig,
    private readonly scopes: string[],
  ) {}

  public debug(message: string, context?: LogContext): void {
    this.write('debug', message, context);
  }

  public spam(message: string, context?: LogContext): void {
    this.write('spam', message, context);
  }

  public info(message: string, context?: LogContext): void {
    this.write('info', message, context);
  }

  public warn(message: string, context?: LogContext): void {
    this.write('warn', message, context);
  }

  public error(message: string, context?: LogContext): void {
    this.write('error', message, context);
  }

  public isEnabled(level: LogLevel): boolean {
    return WEIGHTS[level] >= WEIGHTS[this.config.level];
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (WEIGHTS[level] < WEIGHTS[this.config.level]) {
      return;
    }

    const payload = this.config.json
      ? this.formatJson(level, message, context)
      : this.formatLine(level, message, context);

    const stream = level === 'error' ? this.config.stderr : this.config.stdout;
    stream.write(`${payload}\n`);
    logBuffer.append(payload);
  }

  private formatLine(level: LogLevel, message: string, context?: LogContext): string {
    const ts = new Date().toISOString();
    const scope = this.scopes.join('|');
    const ctx = this.formatContext(context);
    return `[${ts}][${level.toUpperCase()}][${scope}]${ctx} ${message}`;
  }

  private formatJson(level: LogLevel, message: string, context?: LogContext): string {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      scopes: this.scopes,
      message,
      context: context ?? {},
    });
  }

  private formatContext(context?: LogContext): string {
    if (!context || Object.keys(context).length === 0) return '';
    const entries = Object.entries(context)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${this.stringifyValue(value)}`)
      .join(' ');
    return ` [${entries}]`;
  }

  private stringifyValue(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') {
      if (value.length === 0) return '""';
      if (/[\s"\\[\]]/.test(value)) return JSON.stringify(value);
      return value;
    }
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }
}
