/**
 * =============================================================================
 * Runtime Index
 * =============================================================================
 * Central orchestrator and unified export entry for the Loxone AudioServer runtime.
 * =============================================================================
 */

import '@/model/adapters'; // Force adapter dynamic registration
import logger from '@/utils/troxorLogger';
import { configManager } from './config';
import { audioServerRuntime } from './audioServer';
import { startServerHeartbeat, stopServerHeartbeat } from './audioServer/heartbeat';
import { zoneRuntime } from './zones';
import { providerRuntime } from './provider';
import { LoxoneHttp } from '../http/loxoneHttp';
import { AdminHttp } from '../http/adminHttp';
import { SystemConfig } from '../config/types';


/* -------------------------------------------------------------------------- */
/*  SystemRuntime Class                                                       */
/* -------------------------------------------------------------------------- */

class SystemRuntime {
  private loxoneHttp?: LoxoneHttp;
  private adminHttp?: AdminHttp;
  private initialized = false;

  public async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn('[Runtime] Already initialized.');
      return;
    }

    logger.info('[Runtime] Waiting for configuration readiness...');
    await configManager.ready();

    audioServerRuntime.restoreFromConfig();
    await zoneRuntime.initializeZones();
    await providerRuntime.initialize();

    this.loxoneHttp = new LoxoneHttp();
    this.adminHttp = new AdminHttp();
    startServerHeartbeat();

    this.initialized = true;
    logger.info('[Runtime] Initialization complete.');
  }

  public async shutdown(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    stopServerHeartbeat();
    logger.info('[Runtime] Heartbeat stopped.');

    if (this.loxoneHttp) {
      await this.loxoneHttp.shutdown();
    }

    if (this.adminHttp) {
      await this.adminHttp.shutdown();
    }

    this.initialized = false;
    logger.info('[Runtime] Shutdown complete.');
  }

  /**
   * Performs a full runtime reload:
   * - Stops all active services
   * - Reloads configuration from disk
   * - Reinitializes all runtimes
   */
  public async reload(): Promise<void> {
    logger.info('[Runtime] Reload requested...');

    if (this.initialized) {
      logger.info('[Runtime] Shutting down for reload...');
      await this.shutdown();
    }

    try {
      logger.info('[Runtime] Reloading configuration...');
      await configManager.reload();
    } catch (err) {
      logger.error(`[Runtime] Failed to reload configuration: ${String(err)}`);
      return;
    }

    logger.info('[Runtime] Reinitializing runtime...');
    await this.initialize();

    logger.info('[Runtime] Reload complete.');
  }
}

export const systemRuntime = new SystemRuntime();

/* -------------------------------------------------------------------------- */
/*  Convenience exports                                                       */
/* -------------------------------------------------------------------------- */
export { configManager } from './config';
export { audioServerRuntime } from './audioServer';
export { zoneRuntime } from './zones';
export { providerRuntime } from './provider';

/* -------------------------------------------------------------------------- */
/*  Helper Accessors                                                          */
/* -------------------------------------------------------------------------- */

export function getConfig<T>(selector?: (cfg: Readonly<SystemConfig>) => T): T | Readonly<SystemConfig> | null {
  return configManager.get(selector);
}

export const getAudioServerConfig = () => configManager.getAudioServerConfig();
export const getMiniServerConfig = () => configManager.getMiniServerConfig();
export const getZoneConfigs = () => configManager.getZoneConfigs();
export const getLoggingConfig = () => configManager.getLoggingConfig();
export const getMediaProviderConfig = () => configManager.getMediaProviderConfig();