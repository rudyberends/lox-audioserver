/**
 * =============================================================================
 * AudioServerRuntime
 * =============================================================================
 * Handles runtime management of the Loxone AudioServer configuration.
 *
 * Responsibilities:
 *  - Process incoming configuration payloads from the MiniServer.
 *  - Detect and pair the AudioServer based on its MAC ID.
 *  - Extract and persist audio extensions.
 *  - Update MiniServer and Zone configuration.
 *  - Restore persisted extensions on startup.
 * =============================================================================
 */

import { asyncCrc32 } from '@/core/utils/crc32utils';
import logger from '@/utils/troxorLogger';
import { configManager } from '../config';
import { zoneRuntime } from '@/runtime/zones/zoneRuntime';
import { extractExtensions, type ExtensionDescriptor } from './utils/audioExtensions';
import type { AudioServerConfig } from '@/config/types';
import { alertsManager } from './alertsManager';
import { startServerHeartbeat, stopServerHeartbeat } from './heartbeat';

export class AudioServerRuntime {
  /** Cached copy of currently active AudioServer extensions. */
  private extensions: ExtensionDescriptor[] = [];

  /** Submanagers */
  public readonly alerts = alertsManager;

  /* -------------------------------------------------------------------------- */
  /*  Accessors                                                                 */
  /* -------------------------------------------------------------------------- */

  /** Returns the currently known AudioServer extensions. */
  public getExtensions(): ReadonlyArray<ExtensionDescriptor> {
    return this.extensions;
  }

  /* -------------------------------------------------------------------------- */
  /*  Core Methods                                                              */
  /* -------------------------------------------------------------------------- */

  /**
   * Process an AudioServer configuration payload received from the MiniServer.
   * Performs CRC comparison, pairing, extension extraction, and zone rebuild.
   */
  public async processIncomingConfig(data: object | string): Promise<void> {
    try {
      const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);
      const newCrc = await asyncCrc32(jsonStr);
      const parsed = JSON.parse(jsonStr);

      const cfg = configManager.current;
      const currentCrc = cfg.audioserver.musicCrc;
      if (newCrc === currentCrc) {
        logger.info('[AudioServerRuntime] AudioServer config unchanged (CRC match).');
        return;
      }

      const macId = cfg.audioserver.macId ?? '';
      if (!macId) {
        logger.error('[AudioServerRuntime] Missing macId in current AudioServer config.');
        return;
      }

      /* ---------------------------------------------------------------------- */
      /*  1️⃣  Extract AudioServer Section                                       */
      /* ---------------------------------------------------------------------- */

      let server: Record<string, any> | undefined;

      if (Array.isArray(parsed)) {
        const first = parsed[0];
        if (first && typeof first === 'object' && macId in first) {
          server = first[macId];
        }
      } else if (typeof parsed === 'object' && macId in parsed) {
        server = parsed[macId];
      }

      if (!server) {
        logger.warn(`[AudioServerRuntime] No matching AudioServer entry found for MAC ${macId}.`);
        return;
      }

      /* ---------------------------------------------------------------------- */
      /*  2️⃣  Extract and Persist Extensions                                    */
      /* ---------------------------------------------------------------------- */

      const extracted = extractExtensions(parsed, macId) ?? [];
      this.extensions = extracted;

      /* ---------------------------------------------------------------------- */
      /*  3️⃣  Build Updated AudioServer Configuration                           */
      /* ---------------------------------------------------------------------- */

      const updated: AudioServerConfig = {
        ...cfg.audioserver,
        name: server.name ?? 'Unnamed',
        paired: true,
        ip: server.host ?? server.ip ?? '0.0.0.0',
        uuid: server.uuid ?? cfg.audioserver.uuid,
        musicCrc: newCrc,
        lastUpdate: Date.now(),
        extensions: extracted,
      };

      /* ---------------------------------------------------------------------- */
      /*  4️⃣  Update MiniServer and Persist Configuration                       */
      /* ---------------------------------------------------------------------- */

      configManager.update({
        audioserver: updated,
        miniserver: {
          ...cfg.miniserver,
          ip: server.ip ?? cfg.miniserver.ip,
          serial: server.master ?? cfg.miniserver.serial,
          mac: server.master ?? cfg.miniserver.mac,
        },
      });
      await configManager.save();

      logger.info(
        `[AudioServerRuntime] Paired AudioServer "${updated.name}" with ${extracted.length} extensions.`,
      );

      /* ---------------------------------------------------------------------- */
      /*  5️⃣  Initialize / Rebuild Zones                                        */
      /* ---------------------------------------------------------------------- */

      await zoneRuntime.syncWithAudioServer(server);

      // Persist zones directly from runtime
      configManager.update({
        zones: Array.from(zoneRuntime['zones'].values()).map((z) => ({
          id: z.id,
          name: z.name,
          adapter: z.adapter,
          volumes: z.volumes ?? {},
          source: z.source,
          sourceSerial: z.sourceSerial,
        })),
      });

      await configManager.save();

      // ----------------------------------------------------------------------
      //  🔁 Restart heartbeat after config reload
      // ----------------------------------------------------------------------
      stopServerHeartbeat();
      startServerHeartbeat();

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[AudioServerRuntime] Failed to process incoming config: ${msg}`);
    }
  }

  /* -------------------------------------------------------------------------- */
  /*  Restoration                                                               */
  /* -------------------------------------------------------------------------- */

  /**
   * Restores previously saved extensions from the persisted configuration.
   * Called during system startup by the SystemRuntime.
   */
  public restoreFromConfig(): void {
    const a = configManager.getAudioServerConfig();
    this.extensions = Array.isArray(a?.extensions) ? a.extensions : [];

    if (a?.paired) {
      logger.info(
        `[AudioServerRuntime] Restored AudioServer "${a.name}" with ${this.extensions.length} extensions.`,
      );
    } else {
      logger.info('[AudioServerRuntime] No paired AudioServer found; extensions cleared.');
    }
  }

  /* -------------------------------------------------------------------------- */
  /*  Maintenance                                                               */
  /* -------------------------------------------------------------------------- */

  /** Clears in-memory and persisted extensions. */
  public async clearExtensions(): Promise<void> {
    const a = configManager.getAudioServerConfig();
    if (!a) {
      logger.warn('[AudioServerRuntime] No AudioServer section found to clear.');
      return;
    }

    this.extensions = [];
    const updated: AudioServerConfig = { ...a, extensions: [] };
    configManager.update({ audioserver: updated });
    await configManager.save();

    logger.info('[AudioServerRuntime] Cleared AudioServer extensions.');
  }
}

/* -------------------------------------------------------------------------- */
/*  Singleton Export                                                          */
/* -------------------------------------------------------------------------- */

/** Singleton instance used across the AudioServer runtime. */
export const audioServerRuntime = new AudioServerRuntime();
