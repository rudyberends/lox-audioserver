import { loadEnvironment } from '@/config/environment';
import { buildHttpServerConfig } from '@/config/http';
import { buildLoxoneHttpConfig } from '@/config/loxone';

/**
 * Aggregates all configuration builders into a single bootstrap helper.
 */
export const loadConfig = () => {
  const env = loadEnvironment();
  return {
    env,
    http: buildHttpServerConfig(env),
    loxone: buildLoxoneHttpConfig(env),
  };
};

export type AppConfig = ReturnType<typeof loadConfig>;
