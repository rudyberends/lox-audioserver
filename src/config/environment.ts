import type { LogLevel } from '@/core/logging/logger';

/**
 * Canonical view of the process environment consumed by the application.
 */
export interface EnvironmentConfig {
  nodeEnv: 'development' | 'production' | 'test';
  logLevel: LogLevel;
  hostname: string;
  httpPort: number;
  httpHost: string;
  loxoneAppPort: number;
  loxoneMiniserverPort: number;
}

const DEFAULT_APP_PORT = 7091;
const DEFAULT_MS_PORT = 7095;
const DEFAULT_HTTP_PORT = 7090;

/**
 * Reads environment variables, applies validation, and returns a typed object.
 */
export function loadEnvironment(): EnvironmentConfig {
  const hostname = process.env.HOST ?? '0.0.0.0';
  return {
    nodeEnv: resolveNodeEnv(),
    logLevel: resolveLogLevel(process.env.LOG_LEVEL),
    hostname,
    httpPort: parsePort(process.env.HTTP_PORT, DEFAULT_HTTP_PORT),
    httpHost: process.env.HTTP_HOST ?? hostname,
    loxoneAppPort: parsePort(process.env.LOXONE_APP_PORT, DEFAULT_APP_PORT),
    loxoneMiniserverPort: parsePort(
      process.env.LOXONE_MINISERVER_PORT,
      DEFAULT_MS_PORT,
    ),
  };
}

function resolveNodeEnv(): EnvironmentConfig['nodeEnv'] {
  const value = process.env.NODE_ENV?.toLowerCase();
  if (value === 'production' || value === 'test') {
    return value;
  }
  return 'development';
}

function resolveLogLevel(raw?: string): LogLevel {
  switch ((raw ?? '').toLowerCase()) {
    case 'spam':
    case 'debug':
    case 'info':
    case 'warn':
    case 'error':
    case 'none':
      return raw as LogLevel;
    default:
      return 'info';
  }
}

function parsePort(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0 && value < 65535) {
    return value;
  }
  return fallback;
}
