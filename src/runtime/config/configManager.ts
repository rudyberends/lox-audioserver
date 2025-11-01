import { loadConfig as loadConfig, saveConfig as saveConfig } from '../../config/configStore';
import type { SystemConfig } from '../../config/types';
import logger from '@/utils/troxorLogger';

/**
 * -----------------------------------------------------------------------------
 * ConfigManager
 * -----------------------------------------------------------------------------
 * Handles persistent and in-memory configuration for the AudioServer runtime.
 * Provides both full access and type-safe partial access via selector callbacks.
 * -----------------------------------------------------------------------------
 */
export class ConfigManager {
  private config?: SystemConfig;
  private readonly initPromise: Promise<void>;

  constructor() {
    this.initPromise = this.initialize();
  }

  /** Loads configuration from disk at startup. */
  private async initialize(): Promise<void> {
    try {
      this.config = await loadConfig();
      logger.info('[ConfigManager] Loaded configuration from disk.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[ConfigManager] Failed to load configuration: ${msg}`);
      throw err;
    }
  }

  /** Ensures configuration is ready before use. */
  public async ready(): Promise<void> {
    await this.initPromise;
  }

  /** Returns the full configuration object (throws if not yet initialized). */
  public get current(): Readonly<SystemConfig> {
    if (!this.config) {
      throw new Error('[ConfigManager] Not initialized.');
    }
    return this.config;
  }

  /**
   * Returns either the full configuration or a selected value via a type-safe callback.
   *
   * Example:
   * ```ts
   * const cfg = configManager.get();
   * const ip = configManager.get(c => c.audioserver.ip);
   * const defaultVol = configManager.get(c => c.zones[0]?.volumes?.default);
   * ```
   */
  public get<T>(selector?: (cfg: Readonly<SystemConfig>) => T): T | Readonly<SystemConfig> | null {
    if (!this.config) {
      return null;
    }
    if (!selector) {
      return this.config;
    }
    try {
      return selector(this.config);
    } catch {
      return null;
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Section-specific accessors                                                 */
  /* -------------------------------------------------------------------------- */

  /** Returns the AudioServer section of the configuration. */
  public getAudioServerConfig() {
    return this.config?.audioserver;
  }

  /** Returns all configured zones. */
  public getZoneConfigs() {
    return this.config?.zones ?? [];
  }

  /** Returns logging configuration. */
  public getLoggingConfig() {
    return this.config?.logging;
  }

  /** Returns MiniServer configuration. */
  public getMiniServerConfig() {
    return this.config?.miniserver;
  }

  /** Returns media provider configuration. */
  public getMediaProviderConfig() {
    return this.config?.mediaProvider;
  }

  /* -------------------------------------------------------------------------- */
  /* Mutations                                                                  */
  /* -------------------------------------------------------------------------- */

  /** Applies a partial update to the configuration (in-memory only). */
  public update(partial: Partial<SystemConfig>): void {
    if (!this.config) {
      throw new Error('[ConfigManager] Not initialized.');
    }
    this.config = { ...this.config, ...partial };
  }

  /** Persists the current configuration to disk. */
  public async save(): Promise<void> {
    if (!this.config) {
      return;
    }
    await saveConfig(this.config);
    logger.debug('[ConfigManager] Saved configuration to disk.');
  }

  /** Reloads configuration from disk, overwriting the in-memory state. */
  public async reload(): Promise<void> {
    this.config = await loadConfig();
    logger.info('[ConfigManager] Reloaded configuration from disk.');
  }
}

/** Singleton instance (shared across the runtime). */
export const configManager = new ConfigManager();