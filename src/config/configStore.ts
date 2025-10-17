import fs from 'fs';
import path from 'path';
import os from 'os';
import { listBackends } from '../backend/zone/backendFactory';
import { listProviders } from '../backend/provider/factory';

/**
 * Responsible for persisting admin configuration to disk and translating raw JSON into runtime-safe structures.
 */

export interface ZoneConfigEntry {
  id: number;
  backend: string;
  ip: string;
  maPlayerId?: string;
  name?: string;
  source?: string;
  volumes?: ZoneVolumeConfig;
}

export interface ZoneVolumeConfig {
  default?: number;
  alarm?: number;
  fire?: number;
  bell?: number;
  buzzer?: number;
  tts?: number;
  max?: number;
}

export interface MediaProviderConfig {
  type: string;
  options: Record<string, string>;
}

export interface AdminConfig {
  miniserver: {
    ip: string;
    username: string;
    password: string;
    serial: string;
  };
  audioserver: {
    ip: string;
  };
  zones: ZoneConfigEntry[];
  mediaProvider: MediaProviderConfig;
  logging: {
    consoleLevel: string;
    fileLevel: string;
  };
}

export const BACKEND_OPTIONS = Object.freeze(listBackends());
export const PROVIDER_OPTIONS = Object.freeze(listProviders());

export const CONFIG_DIR = process.env.CONFIG_DIR || path.resolve(process.cwd(), 'data');
export const CONFIG_FILE = process.env.CONFIG_FILE || path.join(CONFIG_DIR, 'config.json');

/**
 * Returns the first non-loopback IPv4 address to seed default configs.
 */
export function detectLocalIp(): string {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    const entries = nets[name];
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * Produces a fully populated admin config with sensible defaults.
 */
export function defaultAdminConfig(): AdminConfig {
  return {
    miniserver: { ip: '', username: '', password: '', serial: '' },
    audioserver: { ip: detectLocalIp() },
    zones: [],
    mediaProvider: { type: '', options: {} },
    logging: { consoleLevel: 'info', fileLevel: 'none' },
  };
}

/**
 * Reads the on-disk admin config, rebuilding it with defaults when missing or invalid.
 */
export function loadAdminConfig(): AdminConfig {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    const defaults = defaultAdminConfig();
    saveAdminConfig(defaults);
    return defaults;
  }

  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AdminConfig>;
    return normalizeAdminConfig(parsed);
  } catch (error) {
    console.warn('[configStore] Failed to read config.json. Recreating with defaults.', error);
    const defaults = defaultAdminConfig();
    saveAdminConfig(defaults);
    return defaults;
  }
}

/**
 * Persists a normalized admin config to disk.
 */
export function saveAdminConfig(config: AdminConfig): void {
  ensureConfigDir();
  const normalized = normalizeAdminConfig(config);
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
}

/**
 * Ensures the config directory exists before read/write operations.
 */
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Merges partial config payloads with defaults and strips unsafe values.
 */
function normalizeAdminConfig(raw: Partial<AdminConfig>): AdminConfig {
  const defaults = defaultAdminConfig();
  const miniserver = {
    ip: raw?.miniserver?.ip ?? defaults.miniserver.ip,
    username: raw?.miniserver?.username ?? defaults.miniserver.username,
    password: raw?.miniserver?.password ?? defaults.miniserver.password,
    serial: raw?.miniserver?.serial ?? defaults.miniserver.serial,
  };

  const audioserver = {
    ip: raw?.audioserver?.ip && raw.audioserver.ip.trim() ? raw.audioserver.ip : defaults.audioserver.ip,
  };

  let zones = Array.isArray(raw?.zones)
    ? raw!.zones
        .map((zone) => ({
          id: Number(zone?.id ?? 0),
          backend: String(zone?.backend ?? '').trim(),
          ip: String(zone?.ip ?? '').trim(),
          maPlayerId: zone?.maPlayerId ? String(zone.maPlayerId).trim() : undefined,
          name: typeof zone?.name === 'string' ? zone.name.trim() : undefined,
          source: zone?.source ? String(zone.source).trim() : undefined,
          volumes: normalizeVolumeConfig(zone?.volumes),
        }))
        .filter((zone) => Number.isFinite(zone.id) && zone.backend)
    : [];

  const mediaProvider = {
    type: raw?.mediaProvider?.type ? String(raw.mediaProvider.type).trim() : '',
    options: { ...raw?.mediaProvider?.options },
  };

  const logging = {
    consoleLevel: raw?.logging?.consoleLevel ? String(raw.logging.consoleLevel).trim() : defaults.logging.consoleLevel,
    fileLevel: raw?.logging?.fileLevel ? String(raw.logging.fileLevel).trim() : defaults.logging.fileLevel,
  };

  const legacyVolumes = normalizeVolumeStore((raw as any)?.volumes);
  if (legacyVolumes?.players.length) {
    const volumeMap = new Map<number, ZoneVolumeConfig>();
    legacyVolumes.players.forEach(({ playerid, volumes }) => {
      volumeMap.set(playerid, volumes);
    });
    zones = zones.map((zone) => {
      const merge = volumeMap.get(zone.id);
      if (!merge) return zone;
      const combined = zone.volumes ? { ...zone.volumes, ...merge } : merge;
      return { ...zone, volumes: combined };
    });
  }

  return {
    miniserver,
    audioserver,
    zones,
    mediaProvider,
    logging,
  };
}

function normalizeVolumeConfig(raw: any): ZoneVolumeConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const coerce = (value: any) => {
    const num = Number(value);
    return Number.isFinite(num) && num >= 0 ? Math.min(100, Math.max(0, Math.round(num))) : undefined;
  };
  const result: ZoneVolumeConfig = {
    default: coerce(raw.default),
    alarm: coerce(raw.alarm),
    fire: coerce(raw.fire),
    bell: coerce(raw.bell),
    buzzer: coerce(raw.buzzer),
    tts: coerce(raw.tts),
    max: coerce(raw.max),
  };
  return Object.values(result).some((value) => value !== undefined) ? result : undefined;
}

function normalizeVolumeStore(raw: any): { players: Array<{ playerid: number; volumes: ZoneVolumeConfig }> } | undefined {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.players)) return undefined;
  const players = raw.players
    .map((entry: any) => {
      const playerid = Number(entry?.playerid ?? entry?.id ?? 0);
      if (!Number.isFinite(playerid) || playerid <= 0) return undefined;
      const volumes = normalizeVolumeConfig(entry);
      if (!volumes) return undefined;
      return { playerid, volumes };
    })
    .filter(
      (entry: any): entry is { playerid: number; volumes: ZoneVolumeConfig } =>
        Boolean(entry) && typeof entry.playerid === 'number' && typeof entry.volumes === 'object',
    );
  return players.length > 0 ? { players } : undefined;
}
