import logger from '../utils/troxorlogger';
import { asyncCrc32 } from '../utils/crc32utils';
import { setupZones } from '../backend/zone/zonemanager';
import { loadAdminConfig, saveAdminConfig, detectLocalIp, AdminConfig, ZoneConfigEntry } from './configStore';
import { computeAuthorizationHeader } from './auth';
import { loadMusicCache } from './musicCache';

/**
 * Central configuration orchestrator. Persists admin settings, mirrors them into runtime state,
 * and coordinates sync with the Loxone MiniServer and AudioServer.
 */

interface MiniServerConfig {
  ip: string;
  mac: string;
  username: string;
  password: string;
  serial?: string;
}

interface AudioServerConfig {
  name: string;
  paired: boolean;
  ip: string;
  mac: string;
  macID: string;
  uuid?: string;
  musicCFG?: any;
  musicCRC?: string;
  musicTimestamp?: number;
}

interface Config {
  miniserver: MiniServerConfig;
  audioserver?: AudioServerConfig;
}

interface ZoneVolumeConfig {
  default?: number;
  alarm?: number;
  fire?: number;
  bell?: number;
  buzzer?: number;
  tts?: number;
  max?: number;
}

let adminConfig: AdminConfig = loadAdminConfig();

const config: Config = {
  miniserver: {
    ip: adminConfig.miniserver.ip,
    mac: '',
    serial: adminConfig.miniserver.serial,
    username: adminConfig.miniserver.username,
    password: adminConfig.miniserver.password,
  },
};

/**
 * Base AudioServer values used until a pairing payload arrives from the MiniServer.
 */
const DEFAULT_AUDIO_SERVER: AudioServerConfig = {
  name: 'Unconfigured',
  paired: false,
  ip: adminConfig.audioserver.ip || detectLocalIp(),
  mac: '50:4f:94:ff:1b:b3',
  macID: '504F94FF1BB3',
  musicCFG: '[]',
  musicCRC: 'd4cbb29',
  musicTimestamp: undefined,
};

applyAdminConfig();
seedAudioServerFromCache();

/**
 * Validates and merges the downloaded AudioServer definition into the runtime config.
 */
const processAudioServerConfig = async (audioServerConfigData: any): Promise<AudioServerConfig | null> => {
  try {
    const newMusicCRC = await asyncCrc32(JSON.stringify(audioServerConfigData));

    if (newMusicCRC === config.audioserver?.musicCRC) {
      logger.info('[config][processAudioServerConfig] No changes detected in AudioServer config.');
      return config.audioserver || DEFAULT_AUDIO_SERVER;
    }

    const audioServer: AudioServerConfig = {
      ...DEFAULT_AUDIO_SERVER,
      musicCFG: audioServerConfigData,
      musicCRC: newMusicCRC,
    };

    if (!audioServer.musicCFG || Object.keys(audioServer.musicCFG).length === 0) {
      logger.error('[config][processAudioServerConfig] No AudioServer found in downloaded configuration.');
      logger.error('[config][processAudioServerConfig] Awaiting MiniServer pairing process.');
      return null;
    }

    audioServer.paired = true;

    // Store the freshly processed configuration so downstream modules (e.g. ZoneManager) see the latest data.
    config.audioserver = audioServer;

    for (const [, value] of Object.entries(audioServer.musicCFG)) {
      const audioServerEntry = value as { [key: string]: { master: string; ip: string, name: string; uuid: string } };

      if (audioServerEntry[audioServer.macID]) {
        const masterSerial = audioServerEntry[audioServer.macID].master;
        config.miniserver.ip = audioServerEntry[audioServer.macID].ip;
        config.miniserver.mac = masterSerial;
        config.miniserver.serial = masterSerial;
        audioServer.name = audioServerEntry[audioServer.macID].name;
        audioServer.uuid = audioServerEntry[audioServer.macID].uuid;
        
        if (adminConfig.miniserver.serial !== masterSerial) {
          adminConfig.miniserver.serial = masterSerial;
          adminConfig.miniserver.ip = audioServerEntry[audioServer.macID].ip;
          saveAdminConfig(adminConfig);
        }
        audioServer.name = audioServerEntry[audioServer.macID].name;
        audioServer.uuid = audioServerEntry[audioServer.macID].uuid;
        logger.info(`[config][processAudioServerConfig] Paired AudioServer found [${audioServer.name}]`);
        logger.info('[config][processAudioServerConfig] Requesting Zone initialization from Zone Manager');
        await setupZones();
      }
    }

    return audioServer;
  } catch (error) {
    logger.error('Error processing AudioServer config:', error instanceof Error ? error.message : 'Unknown error');
    return null;
  }
};
/**
 * Bootstraps runtime configuration using the cached Music Assistant payload.
 */
const initializeConfig = async () => {
  try {
    const cached = loadMusicCache();
    let audioServerConfig: AudioServerConfig | null = null;

    if (cached?.musicCFG) {
      logger.info('[initializeConfig] Loading AudioServer configuration from cache.');
      audioServerConfig = await processAudioServerConfig(cached.musicCFG);
      if (audioServerConfig) {
        audioServerConfig.musicTimestamp = cached.timestamp ?? audioServerConfig.musicTimestamp;
        audioServerConfig.musicCRC = cached.crc32 ?? audioServerConfig.musicCRC;
        config.audioserver = audioServerConfig;
        if (cached?.timestamp) {
          config.audioserver.musicTimestamp = cached.timestamp;
        }
        return;
      }
    } else {
      logger.warn('[initializeConfig] No cached AudioServer configuration found. Waiting for MiniServer pairing.');
    }

    if (cached?.musicCFG && !audioServerConfig) {
      logger.warn('[initializeConfig] Cached AudioServer configuration was invalid. Resetting to defaults.');
    }

    config.audioserver = { ...DEFAULT_AUDIO_SERVER, paired: false };
    logger.warn('[initializeConfig] AudioServer is not paired yet. Waiting for Miniserver pairing.');
  } catch (error) {
    logger.error('[initializeConfig] Failed to initialize configuration from cache:', error instanceof Error ? error.message : 'Unknown error');
    config.audioserver = { ...DEFAULT_AUDIO_SERVER };
  }
};

/**
 * Reloads admin configuration from disk and reinitializes runtime state.
 */
const reloadConfiguration = async () => {
  adminConfig = loadAdminConfig();
  applyAdminConfig();
  await initializeConfig();
};

/**
 * Applies persisted admin settings to the in-memory config and environment variables.
 */
function applyAdminConfig() {
  if (!adminConfig.logging) {
    adminConfig.logging = { consoleLevel: 'info', fileLevel: 'none' };
  }
  if (!adminConfig.mediaProvider) {
    adminConfig.mediaProvider = { type: '', options: {} };
  }

  config.miniserver.ip = adminConfig.miniserver.ip || '';
  config.miniserver.username = adminConfig.miniserver.username || '';
  config.miniserver.password = adminConfig.miniserver.password || '';
  config.miniserver.serial = adminConfig.miniserver.serial || '';

  DEFAULT_AUDIO_SERVER.ip = adminConfig.audioserver.ip || detectLocalIp();
  if (!config.audioserver) {
    config.audioserver = { ...DEFAULT_AUDIO_SERVER };
  } else {
    config.audioserver.ip = DEFAULT_AUDIO_SERVER.ip;
  }
  process.env.AUDIOSERVER_IP = config.audioserver.ip;

  if (adminConfig.mediaProvider?.type) {
    process.env.MEDIA_PROVIDER = adminConfig.mediaProvider.type;
  } else {
    delete process.env.MEDIA_PROVIDER;
  }

  Object.keys(process.env)
    .filter((key) => key.startsWith('MEDIA_PROVIDER_'))
    .forEach((key) => delete process.env[key]);

  Object.entries(adminConfig.mediaProvider?.options ?? {}).forEach(([key, value]) => {
    if (value) {
      process.env[`MEDIA_PROVIDER_${key}`] = value;
    }
  });
}

function seedAudioServerFromCache(): void {
  const cached = loadMusicCache();
  if (!cached) {
    return;
  }

  const existing = config.audioserver ?? { ...DEFAULT_AUDIO_SERVER };
  config.audioserver = {
    ...existing,
    musicCFG: cached.musicCFG,
    musicCRC: cached.crc32,
    paired: true,
    musicTimestamp: cached.timestamp ?? existing.musicTimestamp,
  };
}

function sanitizeVolumeValue(value: unknown): number | undefined {
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  const clamped = Math.max(0, Math.min(100, Math.round(num)));
  return clamped;
}

function sanitizeVolumePartial(input: any): ZoneVolumeConfig {
  if (!input || typeof input !== 'object') return {};
  const result: ZoneVolumeConfig = {};
  const mappings: Array<[keyof ZoneVolumeConfig, unknown]> = [
    ['default', input.default],
    ['alarm', input.alarm ?? input.general],
    ['fire', input.fire],
    ['bell', input.bell],
    ['buzzer', input.buzzer ?? input.clock],
    ['tts', input.tts],
    ['max', input.max ?? input.maximum],
  ];
  for (const [key, rawValue] of mappings) {
    const sanitized = sanitizeVolumeValue(rawValue);
    if (sanitized !== undefined) {
      result[key] = sanitized;
    }
  }
  return result;
}

type SanitizedVolumePreset = { playerid: number; volumes: ZoneVolumeConfig };

function sanitizePresetEntry(entry: any): SanitizedVolumePreset | undefined {
  const playerid = Number(entry?.playerid ?? entry?.id);
  if (!Number.isFinite(playerid) || playerid <= 0) return undefined;
  const partial = sanitizeVolumePartial(entry);
  if (Object.keys(partial).length === 0) return undefined;
  return { playerid, volumes: partial };
}

function sanitizePresetList(entries: any[]): SanitizedVolumePreset[] {
  const map = new Map<number, ZoneVolumeConfig>();
  for (const entry of entries) {
    const sanitized = sanitizePresetEntry(entry);
    if (!sanitized) continue;
    const existing = map.get(sanitized.playerid) ?? {};
    map.set(sanitized.playerid, { ...existing, ...sanitized.volumes });
  }
  return Array.from(map.entries()).map(([playerid, volumes]) => ({ playerid, volumes }));
}

function setVolumePresets(presets: any[]): SanitizedVolumePreset[] {
  const sanitized = sanitizePresetList(presets);
  if (sanitized.length === 0) return [];

  const zones = [...adminConfig.zones];
  let mutated = false;

  sanitized.forEach(({ playerid, volumes }) => {
    const index = zones.findIndex((zone) => zone.id === playerid);
    if (index === -1) return;
    const existing = zones[index].volumes ?? {};
    zones[index] = { ...zones[index], volumes: { ...existing, ...volumes } };
    mutated = true;
  });

  if (mutated) {
    updateAdminConfig({
      ...adminConfig,
      zones,
    });
  }

  return sanitized;
}

function setZoneVolumePartial(zoneId: number, partial: ZoneVolumeConfig): ZoneVolumeConfig | undefined {
  const sanitized = sanitizeVolumePartial(partial);
  if (Object.keys(sanitized).length === 0) return undefined;

  const zones = [...adminConfig.zones];
  const index = zones.findIndex((zone) => zone.id === zoneId);
  if (index === -1) {
    logger.warn(`[config] Cannot store volumes: unknown zone ${zoneId}`);
    return undefined;
  }

  const currentVolumes = zones[index].volumes ?? {};
  zones[index] = { ...zones[index], volumes: { ...currentVolumes, ...sanitized } };

  updateAdminConfig({
    ...adminConfig,
    zones,
  });

  return sanitized;
}

function setZoneDefaultVolume(zoneId: number, value: number): ZoneVolumeConfig | undefined {
  return setZoneVolumePartial(zoneId, { default: value });
}

function setZoneMaxVolume(zoneId: number, value: number): ZoneVolumeConfig | undefined {
  return setZoneVolumePartial(zoneId, { max: value });
}

function setZoneEventVolumes(zoneId: number, volumes: Partial<ZoneVolumeConfig>): ZoneVolumeConfig | undefined {
  return setZoneVolumePartial(zoneId, volumes as ZoneVolumeConfig);
}

function getStoredVolumePreset(zoneId: number): ZoneVolumeConfig | undefined {
  const zoneConfig = adminConfig.zones.find((zone) => zone.id === zoneId);
  if (!zoneConfig?.volumes) return undefined;
  return { ...zoneConfig.volumes };
}

function setAudioServerIp(ip: string): string {
  const trimmed = typeof ip === 'string' ? ip.trim() : '';
  const nextConfig: AdminConfig = {
    ...adminConfig,
    audioserver: {
      ...adminConfig.audioserver,
      ip: trimmed,
    },
  };
  updateAdminConfig(nextConfig);
  return nextConfig.audioserver.ip;
}
/**
 * Returns the last cached admin configuration.
 */
function getAdminConfig(): AdminConfig {
  return adminConfig;
}

/**
 * Persists new admin settings and reapplies them to the runtime environment.
 */
function updateAdminConfig(newConfig: AdminConfig): void {
  adminConfig = newConfig;
  saveAdminConfig(adminConfig);
  applyAdminConfig();
}

export {
  config,
  initializeConfig,
  reloadConfiguration,
  processAudioServerConfig,
  getAdminConfig,
  updateAdminConfig,
  computeAuthorizationHeader,
  getStoredVolumePreset,
  setVolumePresets,
  setZoneDefaultVolume,
  setZoneMaxVolume,
  setZoneEventVolumes,
  setAudioServerIp,
};

export type { ZoneVolumeConfig };
