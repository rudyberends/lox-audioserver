import type { LogLevel } from '@/types/logLevel';

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

const DEFAULT_ENVIRONMENT: EnvironmentConfig = {
  nodeEnv: 'development',
  logLevel: 'info',
  hostname: '0.0.0.0',
  httpPort: 7090,
  httpHost: '0.0.0.0',
  loxoneAppPort: 7091,
  loxoneMiniserverPort: 7095,
};

/**
 * Returns the static environment configuration (ENV overrides are not supported).
 */
export function loadEnvironment(): EnvironmentConfig {
  return { ...DEFAULT_ENVIRONMENT };
}
