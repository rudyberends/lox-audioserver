import logger from '@/utils/troxorLogger';
import { configManager } from '../config';
import { getStateMapper, getCommandMapper, getContentPlayer } from '@/model/registry';
import { NullStateMapper, NullCommandMapper } from './utils/nullMappers';
import type { ZoneDefinition } from './types/zoneDefinition';
import type { ZoneEntry } from './types/zoneEntry';
import type { ZoneVolumeConfig } from '@/config/types';
import { createDefaultZoneState, ZoneState } from './types/zoneStateTypes';
import { zoneStateStore } from './zoneStateStore';
import { fadeController } from './utils/fadeController';
import { parseLoxoneCommand } from './utils/loxoneCommandParser';

/**
 * =============================================================================
 * ZoneRuntime
 * =============================================================================
 * Central runtime responsible for managing all zones within the AudioServer.
 *
 * Responsibilities:
 *  - Initialize and manage all active zones
 *  - Instantiate correct StateMapper and CommandMapper per zone
 *  - Attach optional Content Mappers (e.g. Music Assistant)
 *  - Receive and broadcast zone/queue updates via {@link zoneStateStore}
 *  - Persist configuration updates (name, event volumes, etc.)
 * =============================================================================
 */
export class ZoneRuntime {
  /** Internal registry of all active zones. */
  private readonly zones = new Map<number, ZoneEntry>();

  /* -------------------------------------------------------------------------- */
  /* Initialization                                                             */
  /* -------------------------------------------------------------------------- */

  /** Initializes all zones from persistent configuration. */
  public async initializeZones(): Promise<void> {
    const zoneDefs = configManager.getZoneConfigs();
    if (!zoneDefs?.length) {
      logger.warn('[ZoneRuntime] No zones defined in configuration.');
      return;
    }

    logger.info(`[ZoneRuntime] Initializing ${zoneDefs.length} zones...`);
    for (const def of zoneDefs) {
      await this.createZone(def);
    }
  }

  /**
   * Creates and registers a single zone entry from its definition.
   * Handles mapper discovery and optional content-mapper attachment.
   */
  private async createZone(def: ZoneDefinition): Promise<void> {
    const { id, name, adapter, source = '', sourceSerial = '' } = def;
    const type = adapter?.type?.toLowerCase() ?? 'null';
    const params = adapter?.parameters ?? {};

    const StateMapperCtor = getStateMapper(type);
    const CommandMapperCtor = getCommandMapper(type);

    const baseParams = { ...params, zoneId: id, zoneName: name };
    const stateMapper = StateMapperCtor ? new StateMapperCtor(baseParams) : new NullStateMapper();
    const commandMapper = CommandMapperCtor ? new CommandMapperCtor(baseParams) : new NullCommandMapper();

    // -----------------------------------------------------------------------
    // Optional content mapper (for library/service/playlist/url playback)
    // -----------------------------------------------------------------------
    let contentMapper: unknown;

    try {
      const contentCfg = params.contentadapter;
      const providerType: string = (contentCfg?.type ?? type)?.toLowerCase();
      const ContentCtor = getContentPlayer(`${providerType}-playback`);

      if (ContentCtor) {
        const providerCfg = configManager.current.mediaProvider;
        const providerIp = providerCfg?.options?.ip;
        const providerPort = providerCfg?.options?.port ?? 8095;

        if (!providerCfg || providerCfg.type?.toLowerCase() !== providerType) {
          logger.warn(
            `[ZoneRuntime][${name}] No active mediaProvider of type "${providerType}" found in configuration.`,
          );
        }

        const playerId: string | undefined =
          contentCfg?.playerid ?? params?.maPlayerId ?? undefined;

        const initParams = {
          providerId: providerType,
          zoneId: id,
          zoneName: name,
          ip: providerIp as string,
          port: providerPort as number,
          playerId,
        };

        contentMapper = new ContentCtor(initParams);
        await (contentMapper as any)?.initialize?.();

        logger.info(
          `[ZoneRuntime][${name}] Attached content mapper "${providerType}" (playback enabled)`,
        );

      } else {
        logger.debug(`[ZoneRuntime][${name}] No content mapper found for type "${providerType}"`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[ZoneRuntime][${name}] Failed to attach content mapper: ${msg}`);
    }

    // Initialize state
    const defaultState = createDefaultZoneState(id);
    defaultState.name = name;
    zoneStateStore.replace(id, defaultState);

    const entry: ZoneEntry = {
      id,
      name,
      adapter,
      stateMapper,
      commandMapper,
      contentMapper,
      volumes: def.volumes,
      source,
      sourceSerial,
    };
    this.zones.set(id, entry);

    // -----------------------------------------------------------------------
    // Mapper → Runtime callbacks
    // -----------------------------------------------------------------------

    // ZoneState updates
    stateMapper.onUpdate((update: Partial<ZoneState>) => {
      zoneStateStore.patch(id, update);
    });

    // Queue metadata updates
    if ('onQueueUpdate' in stateMapper) {
      (stateMapper as any).onQueueUpdate?.((zoneId: number, queue: any) => {
        this.handleZoneQueueUpdate(zoneId, queue);
      });
    }

    await stateMapper.initialize();
    await (commandMapper as any)?.initialize?.();

    logger.info(`[ZoneRuntime] Registered zone ${id} (${name}) using ${type} mapper`);
  }

  /* -------------------------------------------------------------------------- */
  /* AudioServer Synchronization                                                */
  /* -------------------------------------------------------------------------- */

  /**
   * Synchronizes the configured zones with the current AudioServer payload.
   * This ensures the runtime always reflects the actual connected hardware.
   */
  public async syncWithAudioServer(server: Record<string, unknown>): Promise<void> {
    const players = Array.isArray(server.players) ? server.players : [];
    if (!players.length) {
      logger.warn('[ZoneRuntime] No players found in AudioServer payload.');
      return;
    }

    const currentZones = configManager.getZoneConfigs() ?? [];
    const cfg = configManager.current;
    const audioSerial = String(cfg?.audioserver?.macId ?? cfg?.audioserver?.mac ?? '')
      .trim()
      .toUpperCase();
    const serverName =
      typeof server.name === 'string' && server.name.trim()
        ? server.name.trim()
        : cfg?.audioserver?.name ?? 'AudioServer';

    const extensionMap = new Map<string, { label: string }>();
    const extensions = Array.isArray(server.extensions) ? server.extensions : [];
    extensions.forEach((ext: any, index: number) => {
      if (!ext || typeof ext !== 'object') {
        return;
      }
      const serial = String(ext.serial ?? '').trim().toUpperCase();
      if (!serial) {
        return;
      }
      const name = typeof ext.name === 'string' && ext.name.trim()
        ? ext.name.trim()
        : `Stereo Extension ${index + 1}`;
      extensionMap.set(serial, { label: name });
    });

    const resolvePlayerSource = (player: Record<string, unknown>) => {
      const outputs = Array.isArray(player.outputs) ? player.outputs : [];
      let serial = '';
      for (const output of outputs) {
        const channels = Array.isArray(output?.channels) ? output.channels : [];
        for (const channel of channels) {
          if (channel && typeof channel.id === 'string') {
            const [rawSerial] = channel.id.split('#');
            if (rawSerial) {
              serial = rawSerial.trim().toUpperCase();
              break;
            }
          }
        }
        if (serial) {
          break;
        }
      }

      let label = serverName;
      if (serial) {
        if (extensionMap.has(serial)) {
          label = extensionMap.get(serial)!.label;
        } else if (audioSerial && serial !== audioSerial) {
          const suffix = serial.slice(-4) || serial;
          label = `Stereo Extension ${suffix}`;
        }
      } else {
        serial = audioSerial;
      }

      if (!label && audioSerial && serial === audioSerial) {
        label = serverName;
      }
      return { serial, label: label || serverName };
    };

    const mergedZones = players.map((p: any, index: number) => {
      const id = Number(p.playerid ?? p.id ?? 0);
      const existing = currentZones.find((z) => z.id === id);
      const source = resolvePlayerSource(p);

      return {
        id,
        name: p.name ?? existing?.name ?? `Zone ${id || index + 1}`,
        adapter: existing?.adapter ?? { type: 'null', parameters: {} },
        volumes: existing?.volumes ?? {},
        source: source.label,
        sourceSerial: source.serial,
      };
    });

    const preserved = currentZones
      .filter((z) => !mergedZones.some((m) => m.id === z.id))
      .map((z) => ({ ...z }));

    const finalZones = [...mergedZones, ...preserved];

    this.clearZones();
    logger.info(`[ZoneRuntime] Syncing ${mergedZones.length} zones from AudioServer payload...`);

    for (const def of finalZones) {
      await this.createZone(def);
    }

    configManager.update({ zones: finalZones });
    await configManager.save();

    logger.info('[ZoneRuntime] AudioServer zones synchronized.');
  }

  /* -------------------------------------------------------------------------- */
  /* Command Routing                                                            */
  /* -------------------------------------------------------------------------- */

  public async sendZoneCommand(id: number, command: string, param?: unknown): Promise<void> {
    const zone = this.zones.get(id);
    if (!zone) {
      logger.warn(`[ZoneRuntime] Unknown zone ${id}`);
      return;
    }

    logger.debug(`[ZoneRuntime][${zone.name}] → ${command} ${JSON.stringify(param ?? '')}`);

    const state = zoneStateStore.get(id);
    const parsed = await parseLoxoneCommand(command, param, state.volume ?? 25);

    if (parsed.isContent) {
      if (!zone.contentMapper) {
        logger.warn(`[ZoneRuntime][${zone.name}] No content mapper available.`);
        return;
      }

      // Check for Fade request
      if (parsed.param.fade) {
        fadeController.fadeIn(id, parsed.param.fade.fadeDurationMs);
      }

      await zone.contentMapper.handlePlayCommand({
        zoneId: id,
        ...(parsed.param as any),
      });

      return;
    }
    await zone.commandMapper?.handle(command, parsed.param);
  }

  /* -------------------------------------------------------------------------- */
  /* Queue Updates                                                              */
  /* -------------------------------------------------------------------------- */

  /** Applies queue metadata updates received from state mappers. */
  private handleZoneQueueUpdate(zoneId: number, queue: unknown): void {
    try {
      zoneStateStore.patch(zoneId, { queue });
      const queueSize = Array.isArray((queue as any)?.items)
        ? (queue as any).items.length
        : 0;
      logger.debug(
        `[ZoneRuntime] Queue updated for zone ${zoneId} (${queueSize} items, shuffle=${(queue as any)?.shuffle ?? false})`,
      );
    } catch (err) {
      logger.warn(`[ZoneRuntime] Failed to handle queue update for zone ${zoneId}: ${String(err)}`);
    }
  }

  /* -------------------------------------------------------------------------- */
  /* State Access                                                               */
  /* -------------------------------------------------------------------------- */

  /** Returns the current runtime state for a specific zone. */
  public getZoneState(zoneId: number): ZoneState {
    return zoneStateStore.get(zoneId);
  }

  /** Returns the full list of current zone states. */
  public listZoneStates(): ZoneState[] {
    return zoneStateStore.getAll();
  }

  /** Returns a minimal list of { id, name } pairs for UI use. */
  public listZones(): Array<{ id: number; name: string }> {
    return Array.from(this.zones.values()).map(({ id, name }) => ({ id, name }));
  }

  /** Returns the configured event volume profile for a zone, if available. */
  public getZoneVolumeConfig(zoneId: number): ZoneVolumeConfig | undefined {
    const entry = this.zones.get(zoneId);
    return entry?.volumes;
  }

  /* -------------------------------------------------------------------------- */
  /* Config Persistence                                                         */
  /* -------------------------------------------------------------------------- */

  /**
   * Updates the per-zone event volume configuration and persists it.
   */
  public async setZoneEventVolumes(
    zoneId: number,
    partial: Partial<ZoneVolumeConfig>,
  ): Promise<ZoneVolumeConfig | null> {
    const zone = this.zones.get(zoneId);
    if (!zone) {
      logger.warn(`[ZoneRuntime] setZoneEventVolumes: Zone ${zoneId} not found`);
      return null;
    }

    const merged = { ...zone.volumes, ...partial };
    zone.volumes = merged;

    const zones = configManager.getZoneConfigs() ?? [];
    const updatedZones = zones.map((z) =>
      z.id === zoneId
        ? { ...z, volumes: merged, adapter: z.adapter ?? { type: 'null', parameters: {} } }
        : z,
    );

    configManager.update({ zones: updatedZones });
    await configManager.save();

    zoneStateStore.patch(zoneId, { volume: merged.default });
    logger.info(`[ZoneRuntime][${zone.name}] Updated event volumes`);
    return merged;
  }

  /**
   * Updates metadata (name, etc.) for a zone and persists the configuration.
   */
  public async updateZoneMetadata(
    zoneId: number,
    partial: Partial<Pick<ZoneDefinition, 'name'>>,
  ): Promise<void> {
    const zone = this.zones.get(zoneId);
    if (!zone) {
      logger.warn(`[ZoneRuntime] updateZoneMetadata: Zone ${zoneId} not found`);
      return;
    }

    if (partial.name) {
      zone.name = partial.name;
      zoneStateStore.patch(zoneId, { name: partial.name });
    }

    const zones = configManager.getZoneConfigs() ?? [];
    const updatedZones = zones.map((z) =>
      z.id === zoneId ? { ...z, ...partial } : z,
    );

    configManager.update({ zones: updatedZones });
    await configManager.save();

    logger.info(`[ZoneRuntime][${zone.name}] Updated metadata`);
  }

  /* -------------------------------------------------------------------------- */
  /* Cleanup                                                                    */
  /* -------------------------------------------------------------------------- */

  /** Disposes all mappers and clears every zone entry. */
  public clearZones(): void {
    for (const [, entry] of this.zones.entries()) {
      (entry.stateMapper as any)?.dispose?.();
      (entry.commandMapper as any)?.dispose?.();
      (entry.contentMapper as any)?.dispose?.();
    }
    this.zones.clear();
    zoneStateStore.clear();
    logger.info('[ZoneRuntime] Cleared all zones.');
  }

  /** Gracefully shuts down all zones and releases resources. */
  public async destroy(): Promise<void> {
    logger.info('[ZoneRuntime] Shutting down...');
    for (const [, entry] of this.zones.entries()) {
      await (entry.stateMapper as any)?.dispose?.();
      await (entry.commandMapper as any)?.dispose?.();
      await (entry.contentMapper as any)?.dispose?.();
    }
    this.zones.clear();
    zoneStateStore.clear();
    logger.info('[ZoneRuntime] Shutdown complete.');
  }
}

/** Global singleton instance. */
export const zoneRuntime = new ZoneRuntime();