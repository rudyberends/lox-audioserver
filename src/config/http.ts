import path from 'node:path';
import type { EnvironmentConfig } from '@/config/environment';

/**
 * Runtime options for the HTTP gateway.
 */
export interface HttpServerConfig {
  port: number;
  host: string;
  publicDir: string;
  musicDir: string;
}

/**
 * Creates the HTTP gateway configuration from environment settings.
 */
export function buildHttpServerConfig(env: EnvironmentConfig): HttpServerConfig {
  return {
    port: env.httpPort,
    host: env.httpHost,
    publicDir: resolveDir(process.env.HTTP_PUBLIC_DIR ?? path.resolve(process.cwd(), 'public')),
    musicDir: resolveDir(process.env.HTTP_MUSIC_DIR ?? path.resolve(process.cwd(), 'data', 'music')),
  };
}

function resolveDir(dir: string): string {
  return path.resolve(dir);
}
