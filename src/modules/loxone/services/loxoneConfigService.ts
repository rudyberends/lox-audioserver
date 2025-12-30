import { asyncCrc32 } from '@/core/utils/crc32';
import { createLogger } from '@/core/logging/logger';
import { getConfig, updateConfig } from '@/domain/config/configStore';
import type { AudioServerConfig } from '@/domain/config/types';
import { extractZonesFromLoxoneConfig, buildZoneConfigs } from '@/modules/loxone/services/loxoneZoneExtractor';
import { zoneManager } from '@/modules/zones/zoneManager';
import { contentManager } from '@/modules/content/contentManager';
import { notifyReloadMusicApp } from '@/modules/loxone/ws/notifier';

type RawConfigPayload = {
  raw: unknown;
  rawString: string;
};

/**
 * Lightweight domain service that exposes configuration operations required by
 * the Loxone HTTP handlers.
 */
class LoxoneConfigService {
  private readonly log = createLogger('Loxone', 'ConfigService');

  public getCurrentConfigInfo(): { crc32: string | null; extensions: unknown[] } {
    const cfg = getConfig();
    return {
      crc32: cfg.rawAudioConfig.crc32,
      extensions: cfg.system.audioserver.extensions ?? [],
    };
  }

  public async setRawAudioConfig(payload: RawConfigPayload): Promise<string | null> {
    let crc32: string | null = null;

    await updateConfig(async (cfg) => {
      crc32 = await this.persistRawConfig(cfg, payload);
      this.applySystemMetadata(cfg, payload.raw);
      this.extractZonesFromPayload(cfg, payload.raw);
      zoneManager.replaceAll(cfg.zones, cfg.inputs);
      contentManager.refreshFromConfig();
    });

    return crc32;
  }

  public async applyVolumePreset(players: unknown[]): Promise<number> {
    this.log.info('volume preset applied', { players: players.length });
    return players.length;
  }

  public async applyDefaultVolume(zoneId: number, value: number): Promise<void> {
    await this.updateZone(zoneId, (zone) => {
      zone.volumes.default = value;
    });
  }

  public async applyMaxVolume(zoneId: number, value: number): Promise<void> {
    await this.updateZone(zoneId, (zone) => {
      zone.volumes.maxVolume = value;
    });
  }

  public async applyEventVolumes(
    updater: Record<string, number>,
  ): Promise<void> {
    await updateConfig((cfg) => {
      cfg.zones.forEach((zone) => {
        const volumes = zone.volumes as unknown as Record<string, number>;
        for (const [key, value] of Object.entries(updater)) {
          if (typeof value === 'number' && key in volumes) {
            volumes[key] = value;
          }
        }
      });
    });
  }

  public async applyPlayerNames(
    updates: Array<{ zoneId: number; name: string }>,
  ): Promise<void> {
    if (!updates.length) {
      return;
    }
    await updateConfig((cfg) => {
      for (const { zoneId, name } of updates) {
        const zone = cfg.zones.find((z) => z.id === zoneId);
        if (zone) {
          zone.name = name;
        } else {
          this.log.debug('player name update ignored; unknown zone', { zoneId, name });
        }
      }
    });
    updates.forEach(({ zoneId, name }) => zoneManager.renameZone(zoneId, name));
  }

  private async updateZone(
    zoneId: number,
    updateFn: (zone: AudioServerConfig['zones'][number]) => void,
  ): Promise<void> {
    await updateConfig((cfg) => {
      const zone = cfg.zones.find((z) => z.id === zoneId);
      if (!zone) {
        this.log.warn('zone not found for config update', { zoneId });
        return;
      }
      updateFn(zone);
    });
  }

  private async persistRawConfig(
    cfg: AudioServerConfig,
    payload: RawConfigPayload,
  ): Promise<string> {
    const crc32 = await this.computeCrc(payload.rawString);
    cfg.rawAudioConfig = {
      raw: payload.raw,
      rawString: payload.rawString,
      crc32,
    };
    return crc32;
  }

  public notifyReloadMusicApp(
    action: 'useradd' | 'userdel',
    provider: string,
    userId: string,
  ): void {
    notifyReloadMusicApp(action, provider, userId);
  }

  private extractZonesFromPayload(cfg: AudioServerConfig, parsed: unknown): void {
    const macId = cfg.system.audioserver.macId?.trim().toUpperCase();
    if (!macId || !parsed) {
      return;
    }

    const descriptors = extractZonesFromLoxoneConfig(parsed, macId);
    if (!descriptors.length) {
      return;
    }

    cfg.zones = buildZoneConfigs(descriptors);
  }

  private async computeCrc(rawString: string): Promise<string> {
    return asyncCrc32(rawString);
  }

  private applySystemMetadata(cfg: AudioServerConfig, parsed: unknown): void {
    const macId = cfg.system.audioserver.macId?.trim().toUpperCase();
    if (!macId) {
      return;
    }
    const section = this.findServerSection(parsed, macId);
    if (!section) {
      return;
    }

    const serverIp = this.normalizeString(section.host);
    const name = this.normalizeString(section.name);
    const uuid = this.normalizeString(section.uuid);
    const hostIp = this.normalizeString(section.ip);
    const masterSerial = this.normalizeString(section.master);

    if (serverIp) {
      cfg.system.audioserver.ip = serverIp;
    }
    if (name) {
      cfg.system.audioserver.name = name;
    }
    if (uuid) {
      cfg.system.audioserver.uuid = uuid;
    }
    cfg.system.audioserver.paired = true;

    if (Array.isArray(section.extensions)) {
      cfg.system.audioserver.extensions = section.extensions
        .map((entry: any) => {
          const mac = this.normalizeString(entry?.serial)?.toUpperCase();
          const extName = this.normalizeString(entry?.name);
          if (!mac) {
            return null;
          }
          return {
            mac,
            name: extName || `Extension ${mac.slice(-4)}`,
          };
        })
        .filter(
          (
            entry: { mac: string; name: string } | null,
          ): entry is { mac: string; name: string } => Boolean(entry),
        );
    }

    if (hostIp) {
      cfg.system.miniserver.ip = hostIp;
    }
    if (masterSerial) {
      cfg.system.miniserver.serial = masterSerial;
    }
  }

  private findServerSection(parsed: unknown, macId: string): any | undefined {
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    const needle = macId.trim().toUpperCase();
    const items: Record<string, unknown>[] = parsed as Record<string, unknown>[];
    for (let index = 0; index < items.length; index += 1) {
      const entry: Record<string, unknown> | undefined = items[index];
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const matchKey = Object.keys(entry).find(
        (key) => key.trim().toUpperCase() === needle,
      );
      if (matchKey) {
        return entry[matchKey];
      }
    }
    return undefined;
  }

  private normalizeString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed || undefined;
  }
}

export const loxoneConfigService = new LoxoneConfigService();
