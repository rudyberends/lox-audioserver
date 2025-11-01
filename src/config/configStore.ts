import path from 'path';
import logger from '@/utils/troxorLogger';
import { readJson, writeJson, ensureDir, resolveDataDir } from '@/core/utils/file';
import { SystemConfig } from './types';

/**
 * -----------------------------------------------------------------------------
 * ConfigStore
 * -----------------------------------------------------------------------------
 * Responsible for loading and saving the configuration from disk.
 * Relies on fileUtils for consistent and safe file operations.
 * Provides type safety, default value fallback, and automatic recovery.
 * -----------------------------------------------------------------------------
 */

/** Absolute path to the configuration directory. */
export const CONFIG_DIR = resolveDataDir('.');
/** Absolute path to the JSON configuration file. */
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Creates a default configuration with safe baseline values.
 */
export function createDefaultConfig(): SystemConfig {
  return {
    miniserver: {
      ip: '0.0.0.0',
      //username: '',
      //password: '',
      serial: '',
      mac: '',
    },
    audioserver: {
      ip: '0.0.0.0',
      name: 'Unconfigured',
      paired: false,
      mac: '',
      macId: '504F94FF1BB3',
      musicCrc: '',
      extensions: [],
    },
    zones: [],
    mediaProvider: {
      type: 'local',
      options: {},
    },
    logging: {
      consoleLevel: 'info',
      fileLevel: 'none',
    },
    adminHttp: {
      'enabled': true,
    },
  };
}

/**
 * Loads the configuration from disk.
 * If the file is missing or invalid, a default configuration is created and saved.
 * Automatically merges missing fields with default values to maintain backward compatibility.
 *
 * @returns A valid Config object, guaranteed to contain all required fields.
 */
export async function loadConfig(): Promise<SystemConfig> {
  try {
    await ensureDir(CONFIG_DIR);

    const data = await readJson<Partial<SystemConfig>>(CONFIG_FILE);
    if (!data) {
      logger.warn('[configStore] No configuration file found. Creating defaults.');
      const defaults = createDefaultConfig();
      await saveConfig(defaults);
      return defaults;
    }

    const defaults = createDefaultConfig();

    const merged: SystemConfig = {
      ...defaults,
      ...data,
      miniserver: { ...defaults.miniserver, ...data.miniserver },
      audioserver: { ...defaults.audioserver, ...data.audioserver },
      zones: Array.isArray(data.zones) ? data.zones : [],
      mediaProvider: {
        type: data.mediaProvider?.type ?? defaults.mediaProvider!.type,
        options: data.mediaProvider?.options ?? defaults.mediaProvider!.options,
      },
      logging: {
        consoleLevel: data.logging?.consoleLevel ?? defaults.logging!.consoleLevel,
        fileLevel: data.logging?.fileLevel ?? defaults.logging!.fileLevel,
      },
    };

    logger.info('[configStore] Loaded configuration from disk.');
    return merged;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[configStore] Failed to load config: ${msg}`);
    const fallback = createDefaultConfig();
    await saveConfig(fallback);
    return fallback;
  }
}

/**
 * Persists the given configuration to disk.
 * Automatically creates the directory if it doesn’t exist.
 *
 * @param config - The Config object to save.
 * @throws If writing the file fails for any reason.
 */
export async function saveConfig(config: SystemConfig): Promise<void> {
  try {
    await ensureDir(CONFIG_DIR);
    await writeJson(CONFIG_FILE, config);
    logger.debug('[configStore] Saved configuration.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[configStore] Failed to save config: ${msg}`);
    throw err;
  }
}