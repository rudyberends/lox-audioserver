import { IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { configManager } from '@/runtime/config';
import { createDefaultConfig } from '@/config/configStore';
import type { SystemConfig } from '@/config/types/systemConfig';
import type { ZoneConfigEntry } from '@/config/types/zoneConfig';
import { zoneRuntime, zoneStateStore } from '@/runtime/zones';
import { providerRuntime } from '@/runtime/provider';
import { getCommandMapperMeta, getCommandMapperValidator, listCommandMappers } from '@/model/registry/commandMapperRegistry';
import type { AdapterConfigSchema } from '@/model/registry/commandMapperRegistry';
import { getContentProviderMeta, listContentProviders } from '@/model/registry/contentProviderRegistry';
import { getContentPlayerMeta, listContentPlayers } from '@/model/registry/contentPlayerRegistry';
import { AudioPowerState } from '@/core/types/loxone';
import { MusicAssistantApi } from '@/model/adapters/musicAssistant/api';
import type { ZoneState } from '@/runtime/zones/types/zoneStateTypes';
import logger, { logStreamEmitter } from '@/utils/troxorLogger';

const API_PREFIX = '/api';
const ADMIN_API_PREFIX = '/admin/api';
const LOG_FILE_PATH = path.resolve(process.cwd(), 'log/loxone-audio-server.log');
const MAX_LOG_BYTES = 250_000;
const APP_VERSION = readAppVersion();

type JsonValue = Record<string, any> | any[];

const logClients = new Map<ServerResponse, NodeJS.Timeout>();

logStreamEmitter.on('log', (entry: any) => {
  const timestamp = entry?.timestamp ?? new Date().toISOString();
  const level = entry?.level ?? 'info';
  const formatted =
    typeof entry?.formatted === 'string'
      ? entry.formatted
      : typeof entry?.message === 'string'
        ? entry.message
        : '';
  const line = formatted || `[${timestamp}][${level}]`;
  broadcastLogEvent({ line, timestamp, level });
});

export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body?: unknown,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const pathname = normalizeApiPath(req.url ?? '/');

  try {
    if (pathname === '/ping' && method === 'GET') {
      return sendJson(res, 200, { ok: true, ts: Date.now() });
    }

    if (pathname === '/info' && method === 'GET') {
      return sendJson(res, 200, { version: APP_VERSION, uptime: process.uptime() });
    }

    if (pathname === '/config') {
      if (method === 'GET') {
        return handleGetConfig(res);
      }
      if (method === 'POST') {
        return handlePostConfig(body, res);
      }
      return sendMethodNotAllowed(res, ['GET', 'POST']);
    }

    if (pathname === '/config/reload' && method === 'POST') {
      return handleReloadConfig(res);
    }

    if (pathname === '/config/clear' && method === 'POST') {
      return handleClearConfig(res);
    }

    if (pathname === '/zones/connect' && method === 'POST') {
      return handleConnectZone(body, res);
    }

    if (pathname === '/adapters/validate' && method === 'POST') {
      return handleValidateAdapter(body, res);
    }

    if (pathname === '/zones/states' && method === 'GET') {
      return handleGetZoneStates(res);
    }

    if (pathname === '/musicassistant/players') {
      if (method === 'GET' || method === 'POST') {
        return handleMusicAssistantPlayers(req, body, res);
      }
      return sendMethodNotAllowed(res, ['GET', 'POST']);
    }

    if (pathname === '/logs') {
      if (method === 'GET') {
        return handleGetLogs(res);
      }
      return sendMethodNotAllowed(res, ['GET']);
    }

    if (pathname === '/logs/stream' && method === 'GET') {
      return handleLogsStream(req, res);
    }

    if (pathname === '/logs/level' && method === 'POST') {
      return handleUpdateLogLevel(body, res);
    }

    if (pathname === '/ping' && method === 'POST') {
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: 'Unknown API endpoint' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[AdminApi] Unhandled error for ${method} ${pathname}: ${message}`);
    return sendJson(res, 500, { error: 'Internal Server Error', message });
  }
}

/* -------------------------------------------------------------------------- */
/* Route handlers                                                             */
/* -------------------------------------------------------------------------- */

async function handleGetConfig(res: ServerResponse): Promise<void> {
  await configManager.ready();
  const current = (configManager.get() ?? createDefaultConfig()) as SystemConfig;

  const config = mapSystemConfigToAdmin(current);
  const options = buildOptions();
  const zoneStatus = buildZoneStatus(current.zones ?? []);

  return sendJson(res, 200, {
    config,
    options,
    suggestions: [],
    zoneStatus,
    version: APP_VERSION,
  });
}

async function handlePostConfig(body: unknown, res: ServerResponse): Promise<void> {
  await configManager.ready();

  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { success: false, message: 'Missing JSON body' });
  }

  const payload = body as { config?: any };
  if (!payload.config || typeof payload.config !== 'object') {
    return sendJson(res, 400, { success: false, message: 'Missing config payload' });
  }

  const current = (configManager.get() ?? createDefaultConfig()) as SystemConfig;
  const next = applyAdminConfig(current, payload.config);

  configManager.update(next);
  await configManager.save();
  await reinitializeRuntimes();

  return sendJson(res, 200, { success: true, message: 'Configuration saved.' });
}

async function handleReloadConfig(res: ServerResponse): Promise<void> {
  await configManager.reload();
  await reinitializeRuntimes();
  return sendJson(res, 200, { success: true, message: 'Runtime reloaded.' });
}

async function handleClearConfig(res: ServerResponse): Promise<void> {
  const defaults = createDefaultConfig();
  configManager.update(defaults);
  await configManager.save();
  await providerRuntime.dispose();
  await zoneRuntime.clearZones();
  return sendJson(res, 200, { success: true, message: 'Configuration reset to defaults.' });
}

async function handleConnectZone(body: unknown, res: ServerResponse): Promise<void> {
  await configManager.ready();

  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { success: false, message: 'Missing JSON body' });
  }

  const payload = body as {
    playerId?: number;
    zone?: {
      id?: number;
      adapter?: {
        type?: string;
        parameters?: Record<string, any>;
      };
      contentAdapter?: {
        id?: string;
        playerId?: string;
      };
      backend?: string;
      ip?: string;
      maPlayerId?: string;
      name?: string;
      volumes?: Record<string, unknown>;
    };
  };

  const playerId = Number(payload.playerId ?? payload.zone?.id);
  if (!Number.isFinite(playerId) || playerId <= 0) {
    return sendJson(res, 400, { success: false, message: 'Invalid playerId' });
  }

  const currentZones = (configManager.getZoneConfigs() ?? []) as ZoneConfigEntry[];
  const mappedZone = mapAdminZoneToSystem(playerId, payload.zone ?? {});
  const existingIndex = currentZones.findIndex((z) => z.id === playerId);
  const nextZones =
    existingIndex >= 0
      ? currentZones.map((zone, index) => (index === existingIndex ? mappedZone : zone))
      : [...currentZones, mappedZone];

  configManager.update({ zones: nextZones });
  await configManager.save();
  await reinitializeZones();

  const zoneStatus = buildZoneStatus(nextZones);
  return sendJson(res, 200, {
    success: true,
    message: `Zone ${playerId} connected.`,
    zoneStatus,
  });
}

async function handleValidateAdapter(body: unknown, res: ServerResponse): Promise<void> {
  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { success: false, message: 'Missing JSON body' });
  }

  const payload = body as { type?: string; parameters?: Record<string, any> };
  const adapterType = normalizeAdapterType(payload.type);
  if (!adapterType || adapterType === 'null') {
    return sendJson(res, 200, { success: true, message: 'Adapter validation not required.' });
  }

  const validator = getCommandMapperValidator(adapterType);
  if (!validator) {
    return sendJson(res, 200, { success: true, message: 'No validator registered for adapter.' });
  }

  const parameters = normalizeAdapterParametersOutput(payload.parameters ?? {});

  try {
    await validator(parameters);
    return sendJson(res, 200, { success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(res, 400, { success: false, message });
  }
}

async function handleGetZoneStates(res: ServerResponse): Promise<void> {
  const states = zoneRuntime.listZoneStates();
  const mapped = states
    .map(mapZoneStateForAdmin)
    .sort((a, b) => a.id - b.id);
  return sendJson(res, 200, {
    zones: mapped,
    updatedAt: Date.now(),
  });
}

async function handleMusicAssistantPlayers(
  req: IncomingMessage,
  body: unknown,
  res: ServerResponse,
): Promise<void> {
  await configManager.ready();

  const url = req.url ? new URL(req.url, 'http://localhost') : new URL('http://localhost');
  const searchIp = url.searchParams.get('ip') ?? undefined;
  const searchPort = url.searchParams.get('port') ?? undefined;

  const payload = (body && typeof body === 'object') ? (body as Record<string, any>) : {};
  const rawIp = typeof payload.ip === 'string' ? payload.ip : searchIp;
  const ipCandidate = rawIp ?? configManager.current.mediaProvider?.options?.ip;
  const ip = typeof ipCandidate === 'string' ? ipCandidate.trim() : '';
  const rawPort =
    payload.port ??
    (typeof searchPort === 'string' ? Number(searchPort) : undefined) ??
    configManager.current.mediaProvider?.options?.port ??
    8095;
  const port = Number(rawPort) || 8095;

  if (!ip) {
    return sendJson(res, 400, { success: false, message: 'Missing Music Assistant host' });
  }

  try {
    const api = MusicAssistantApi.getInstance(ip, port);
    await api.connect();
    const players = await api.getAllPlayers();
    const mapped = (Array.isArray(players) ? players : []).map((player: any) => {
      const id = player?.queue_id ?? player?.player_id ?? player?.id ?? '';
      const name = player?.display_name ?? player?.name ?? String(id);
      return { id: String(id), name: String(name) };
    });
    return sendJson(res, 200, { success: true, players: mapped });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[AdminApi] Failed to load Music Assistant players: ${message}`);
    return sendJson(res, 500, { success: false, message: 'Failed to load Music Assistant players.' });
  }
}

async function handleGetLogs(res: ServerResponse): Promise<void> {
  try {
    if (!fs.existsSync(LOG_FILE_PATH)) {
      return sendJson(res, 200, {
        success: true,
        log: '',
        truncated: false,
        size: 0,
        missing: true,
        path: path.relative(process.cwd(), LOG_FILE_PATH),
        updatedAt: null,
        limit: MAX_LOG_BYTES,
      });
    }

    const stats = await fsp.stat(LOG_FILE_PATH);
    const buffer = await fsp.readFile(LOG_FILE_PATH);
    const sliceStart = buffer.byteLength > MAX_LOG_BYTES ? buffer.byteLength - MAX_LOG_BYTES : 0;
    const truncated = sliceStart > 0;
    const content = buffer.subarray(sliceStart).toString('utf8');

    return sendJson(res, 200, {
      success: true,
      log: content,
      truncated,
      size: stats.size,
      missing: false,
      path: path.relative(process.cwd(), LOG_FILE_PATH),
      updatedAt: stats.mtime.toISOString(),
      limit: MAX_LOG_BYTES,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[AdminApi] Failed to read logs: ${message}`);
    return sendJson(res, 500, { success: false, message: 'Failed to read logs.' });
  }
}

function handleLogsStream(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  res.write(': connected\n\n');

  const heartbeat = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(heartbeat);
      logClients.delete(res);
      return;
    }
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
      logClients.delete(res);
    }
  }, 15000);

  logClients.set(res, heartbeat);

  req.on('close', () => {
    clearInterval(heartbeat);
    logClients.delete(res);
  });
}

async function handleUpdateLogLevel(body: unknown, res: ServerResponse): Promise<void> {
  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { success: false, message: 'Missing JSON body' });
  }
  const levelRaw = (body as Record<string, unknown>).level;
  const level = typeof levelRaw === 'string' ? levelRaw.trim() : '';
  if (!level || !Object.prototype.hasOwnProperty.call((logger as any).levels ?? {}, level)) {
    return sendJson(res, 400, { success: false, message: 'Unknown log level' });
  }
  logger.setConsoleLogLevel(level);
  return sendJson(res, 200, { success: true, message: `Log level set to ${level}.` });
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function normalizeApiPath(url: string): string {
  try {
    const parsed = new URL(url, 'http://localhost');
    return normalizePrefix(parsed.pathname);
  } catch {
    return normalizePrefix(url);
  }
}

function normalizePrefix(pathname: string): string {
  let normalized = pathname || '/';
  if (normalized.startsWith(ADMIN_API_PREFIX)) {
    normalized = normalized.slice(ADMIN_API_PREFIX.length) || '/';
  } else if (normalized.startsWith(API_PREFIX)) {
    normalized = normalized.slice(API_PREFIX.length) || '/';
  }
  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }
  return normalized.replace(/\/{2,}/g, '/');
}

function sendJson(res: ServerResponse, status: number, payload: JsonValue): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendMethodNotAllowed(res: ServerResponse, allowed: string[]): void {
  res.writeHead(405, { 'Content-Type': 'application/json', Allow: allowed.join(', ') });
  res.end(JSON.stringify({ error: 'Method Not Allowed' }));
}

function toPascalCase(input: string): string {
  return input
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function toProviderName(id: string | undefined): string {
  const key = (id ?? '').trim().toLowerCase();
  if (!key || key === 'dummyprovider') {
    return 'DummyProvider';
  }
  return `${toPascalCase(key)}Provider`;
}

function fromProviderName(name: string | undefined): string {
  const normalized = (name ?? '').trim();
  if (!normalized || normalized.toLowerCase() === 'dummyprovider') {
    return '';
  }
  return normalized.replace(/Provider$/i, '').toLowerCase();
}

function formatContentPlayerLabel(baseType: string): string {
  const normalized = (baseType ?? '').trim().toLowerCase();
  if (!normalized) {
    return 'Content Player';
  }
  if (normalized === 'musicassistant') {
    return 'Music Assistant';
  }
  if (normalized === 'beolink') {
    return 'BeoLink';
  }
  const withSpaces = normalized.replace(/[-_]+/g, ' ');
  return withSpaces.replace(/\b\w/g, (char) => char.toUpperCase());
}

function toContentAdapterSelectId(baseType: string): string {
  const normalized = (baseType ?? '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }
  return `${normalized}-playback`;
}

function fromContentAdapterSelectId(selectId: string): string {
  const normalized = (selectId ?? '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }
  return normalized.endsWith('-playback')
    ? normalized.slice(0, -'-playback'.length)
    : normalized;
}

function normalizeAdapterType(type: string | undefined): string {
  const normalized = (type ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'dummy' || normalized === 'dummybackend') {
    return 'null';
  }
  return normalized;
}

function formatAdapterLabel(adapterId: string, displayName?: string): string {
  if (displayName) {
    return displayName;
  }
  return formatContentPlayerLabel(adapterId);
}

function mergeContentAdapter(
  parameters: Record<string, any>,
  adapterCandidate: Record<string, any> | undefined,
): void {
  if (!adapterCandidate || typeof adapterCandidate !== 'object') {
    return;
  }
  const rawId = adapterCandidate.id ?? adapterCandidate.type;
  const adapterId = typeof rawId === 'string' ? rawId.trim() : '';
  const baseType = fromContentAdapterSelectId(adapterId);
  if (!baseType) {
    return;
  }
  const playerIdRaw = adapterCandidate.playerId ?? adapterCandidate.playerid;
  const contentConfig: Record<string, any> = { type: baseType };
  if (playerIdRaw) {
    contentConfig.playerid = String(playerIdRaw).trim();
  }
  parameters.contentadapter = contentConfig;
}

function normalizeAdapterParametersOutput(raw: unknown): Record<string, any> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const normalized: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw as Record<string, any>)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === 'string') {
      normalized[key] = value.trim();
      continue;
    }
    if (key.toLowerCase() === 'contentadapter' && typeof value === 'object') {
      mergeContentAdapter(normalized, value as Record<string, any>);
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

function extractContentAdapterDisplay(parameters: Record<string, any>) {
  const raw = parameters?.contentadapter;
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const baseType = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
  if (!baseType) {
    return undefined;
  }
  const playerId =
    typeof raw.playerid === 'string'
      ? raw.playerid
      : typeof (raw as any).playerId === 'string'
        ? (raw as any).playerId
        : '';
  return {
    id: toContentAdapterSelectId(baseType),
    playerId,
  };
}

function legacyBackendToAdapterType(name: string | undefined): string {
  const normalized = (name ?? '').trim();
  if (!normalized || normalized.toLowerCase() === 'dummybackend') {
    return 'null';
  }
  if (/^backend/i.test(normalized)) {
    return normalized.slice('backend'.length).toLowerCase();
  }
  return normalized.toLowerCase();
}

function normalizeProviderType(type: string | undefined): string {
  const normalized = (type ?? '').trim();
  if (!normalized || normalized.toLowerCase() === 'dummyprovider') {
    return 'dummy';
  }
  if (/provider$/i.test(normalized)) {
    return normalized.replace(/provider$/i, '').toLowerCase();
  }
  return normalized.toLowerCase();
}

function formatProviderLabelFromId(providerId: string, displayName?: string): string {
  if (displayName) {
    return displayName;
  }
  const normalized = providerId.trim();
  if (!normalized || normalized === 'dummy') {
    return 'Dummy Provider';
  }
  const withSpaces = normalized.replace(/[-_]+/g, ' ');
  return withSpaces.replace(/\b\w/g, (char) => char.toUpperCase());
}

function mapSystemConfigToAdmin(config: SystemConfig) {
  return {
    miniserver: {
      ip: config.miniserver?.ip ?? '',
      username: (config as any).miniserver?.username ?? '',
      password: (config as any).miniserver?.password ?? '',
      serial: config.miniserver?.serial ?? '',
    },
    audioserver: {
      ip: config.audioserver?.ip ?? '',
      paired: Boolean(config.audioserver?.paired),
      name: config.audioserver?.name ?? '',
      macId: config.audioserver?.macId ?? config.audioserver?.mac ?? '',
      serial: config.audioserver?.mac ?? '',
      extensions: Array.isArray(config.audioserver?.extensions)
        ? config.audioserver.extensions.map((extension, index) => ({
          serial: extension?.serial ?? extension?.mac ?? '',
          name: extension?.name ?? `Stereo Extension ${index + 1}`,
          mac: extension?.mac ?? '',
          index: typeof (extension as any)?.index === 'number' ? (extension as any).index : index + 1,
        }))
        : [],
    },
    zones: (config.zones ?? []).map(mapSystemZoneToAdmin),
    mediaProvider: {
      type: toProviderName(config.mediaProvider?.type),
      options: mapProviderOptionsToAdmin(config.mediaProvider?.type, config.mediaProvider?.options ?? {}),
    },
    logging: {
      consoleLevel: config.logging?.consoleLevel ?? 'info',
      fileLevel: config.logging?.fileLevel ?? 'none',
    },
  };
}

function mapSystemZoneToAdmin(zone: ZoneConfigEntry) {
  const adapterType = normalizeAdapterType(zone?.adapter?.type);
  const parameters = normalizeAdapterParametersOutput(zone?.adapter?.parameters);
  const contentAdapter = extractContentAdapterDisplay(parameters);

  return {
    id: zone.id,
    name: zone.name ?? '',
    adapter: {
      type: adapterType,
      parameters,
    },
    volumes: zone.volumes ?? {},
    source: zone.source ?? '',
    sourceSerial: zone.sourceSerial ?? '',
    contentAdapter,
  };
}

function applyAdminConfig(current: SystemConfig, admin: any): SystemConfig {
  const miniserver = {
    ...current.miniserver,
    ip: String(admin?.miniserver?.ip ?? current.miniserver.ip ?? '').trim(),
    username: String(admin?.miniserver?.username ?? (current as any).miniserver?.username ?? '').trim(),
    password: String(admin?.miniserver?.password ?? (current as any).miniserver?.password ?? '').trim(),
    serial: String(admin?.miniserver?.serial ?? current.miniserver.serial ?? '').trim(),
  };

  const audioserver = {
    ...current.audioserver,
    ip: String(admin?.audioserver?.ip ?? current.audioserver.ip ?? '').trim(),
  };

  const zones = mapAdminZones(admin?.zones);
  const mediaProvider = mapAdminProvider(admin?.mediaProvider, current.mediaProvider);

  const logging = {
    consoleLevel: String(admin?.logging?.consoleLevel ?? current.logging?.consoleLevel ?? 'info'),
    fileLevel: String(admin?.logging?.fileLevel ?? current.logging?.fileLevel ?? 'none'),
  };

  return {
    ...current,
    miniserver,
    audioserver,
    zones,
    mediaProvider,
    logging,
  };
}

function mapAdminZones(zones: any): ZoneConfigEntry[] {
  if (!Array.isArray(zones)) {
    return [];
  }

  return zones
    .map((zone) => {
      const id = Number(zone?.id);
      if (!Number.isFinite(id) || id <= 0) {
        return null;
      }
      return mapAdminZoneToSystem(id, zone);
    })
    .filter(Boolean) as ZoneConfigEntry[];
}

function mapAdminZoneToSystem(id: number, zone: any): ZoneConfigEntry {
  const parameters: Record<string, any> = {};
  let adapterType = 'null';

  if (zone?.adapter && typeof zone.adapter === 'object') {
    const rawType = typeof zone.adapter.type === 'string' ? zone.adapter.type.trim() : '';
    adapterType = normalizeAdapterType(rawType);
    Object.assign(parameters, normalizeAdapterParametersOutput(zone.adapter.parameters));
    mergeContentAdapter(parameters, zone.adapter.contentAdapter as Record<string, any> | undefined);
  }

  if (zone?.contentAdapter && !parameters.contentadapter) {
    mergeContentAdapter(parameters, zone.contentAdapter);
  }

  if (!zone?.adapter) {
    adapterType = legacyBackendToAdapterType(zone?.backend);
    const ip = typeof zone?.ip === 'string' ? zone.ip.trim() : '';
    if (ip) {
      parameters.ip = ip;
    }
    const maPlayerId = typeof zone?.maPlayerId === 'string' ? zone.maPlayerId.trim() : '';
    if (maPlayerId) {
      parameters.maPlayerId = maPlayerId;
    }
  }

  return {
    id,
    name: typeof zone?.name === 'string' ? zone.name.trim() : `Zone ${id}`,
    adapter: {
      type: adapterType || 'null',
      parameters,
    },
    volumes: typeof zone?.volumes === 'object' ? zone.volumes : undefined,
    source: typeof zone?.source === 'string' ? zone.source.trim() : undefined,
    sourceSerial: typeof zone?.sourceSerial === 'string' ? zone.sourceSerial.trim() : undefined,
  };
}

function mapAdminProvider(provider: any, fallback: SystemConfig['mediaProvider']) {
  const type = fromProviderName(provider?.type) || fallback?.type || '';
  const options = mapAdminProviderOptions(type, provider?.options, fallback?.options ?? {});
  return { type, options };
}

function mapProviderOptionsToAdmin(
  providerType: string | undefined,
  options: Record<string, any>,
): Record<string, any> {
  const normalizedType = normalizeProviderType(providerType);
  if (!options || typeof options !== 'object') {
    return {};
  }

  const meta = normalizedType === 'dummy' ? undefined : getContentProviderMeta(normalizedType);
  const schemaFields = meta?.configSchema?.fields ?? [];
  const result: Record<string, any> = {};

  if (!schemaFields.length) {
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined || value === null) {
        continue;
      }
      result[key.toLowerCase()] = typeof value === 'string' ? value.trim() : value;
    }
    return result;
  }

  schemaFields.forEach((field) => {
    const targetKey = field.id;
    const match = Object.entries(options).find(([key]) => key.toLowerCase() === targetKey.toLowerCase());
    if (!match) {
      return;
    }
    const [, rawValue] = match;
    if (rawValue === undefined || rawValue === null) {
      return;
    }
    if (typeof rawValue === 'string') {
      result[targetKey] = rawValue.trim();
    } else {
      result[targetKey] = rawValue;
    }
  });

  return result;
}

function mapAdminProviderOptions(
  providerType: string,
  options: Record<string, any> | undefined,
  fallback: Record<string, any>,
): Record<string, any> {
  const result: Record<string, any> = { ...fallback };
  if (!options || typeof options !== 'object') {
    return result;
  }

  const normalizedType = normalizeProviderType(providerType);
  const meta = normalizedType === 'dummy' ? undefined : getContentProviderMeta(normalizedType);
  const schemaFields = meta?.configSchema?.fields ?? [];

  if (!schemaFields.length) {
    for (const [key, value] of Object.entries(options)) {
      const normalizedKey = key.toLowerCase();
      if (value === undefined || value === null) {
        delete result[normalizedKey];
        continue;
      }
      if (normalizedKey === 'port') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          result.port = parsed;
        }
      } else {
        result[normalizedKey] = typeof value === 'string' ? value.trim() : value;
      }
    }
    return result;
  }

  schemaFields.forEach((field) => {
    const rawValue = (options as Record<string, any>)[field.id];
    const targetKey = field.id.toLowerCase();
    if (rawValue === undefined || rawValue === null || rawValue === '') {
      delete result[targetKey];
      return;
    }
    if (field.inputType === 'number') {
      const parsed = Number(rawValue);
      if (Number.isFinite(parsed)) {
        result[targetKey] = parsed;
      }
    } else {
      result[targetKey] = typeof rawValue === 'string' ? rawValue.trim() : rawValue;
    }
  });

  return result;
}

function buildOptions() {
  const adapterIds = listCommandMappers();
  const providerIds = listContentProviders();
  const contentPlayerIds = listContentPlayers();
  const contentPlayerIdSet = new Set(contentPlayerIds.map((id) => id.toLowerCase()));

  const adapters = [
    {
      id: 'null',
      type: 'null',
      label: 'No Adapter',
      description: 'Unconfigured Zone',
      version: '1.0.0',
      configSchema: { fields: [] },
      supportsContentPlayback: false,
      suggestedProviderType: '',
    },
    ...adapterIds.map((adapterId) => {
      const normalizedId = adapterId.toLowerCase();
      const meta = getCommandMapperMeta(adapterId) ?? {};
      const configSchema = normalizeAdapterConfig(meta.configSchema);
      const supportsContentPlayback = contentPlayerIdSet.has(`${normalizedId}-playback`);
      return {
        id: normalizedId,
        type: normalizedId,
        label: formatAdapterLabel(normalizedId, meta.displayName),
        description: meta.description ?? '',
        version: meta.version ?? '',
        configSchema,
        supportsContentPlayback,
        suggestedProviderType: meta.suggestedProviderType ?? '',
      };
    }),
  ];

  const providers = [
    {
      id: 'dummy',
      type: 'dummy',
      legacyName: 'DummyProvider',
      label: 'Dummy Provider',
      description: 'Disables external media sources. Useful for testing or when no provider should be exposed to Loxone.',
      version: '1.0.0',
      configSchema: { fields: [] },
    },
    ...providerIds.map((providerId) => {
      const normalizedId = providerId.toLowerCase();
      const legacyName = toProviderName(providerId);
      const meta = getContentProviderMeta(providerId) ?? {};
      const configSchema = normalizeAdapterConfig(meta.configSchema);
      return {
        id: normalizedId,
        type: normalizedId,
        legacyName,
        label: formatProviderLabelFromId(normalizedId, meta.displayName),
        description: meta.description ?? '',
        version: meta.version ?? '',
        configSchema,
      };
    }),
  ];

  const contentPlayers = contentPlayerIds.map((id) => {
    const lowercaseId = id.toLowerCase();
    const baseType = fromContentAdapterSelectId(id) || lowercaseId.replace(/-playback$/i, '').toLowerCase();
    const meta = getContentPlayerMeta(id);
    const label = meta?.displayName
      ? meta.displayName
      : meta?.description
        ? meta.description
        : `${formatContentPlayerLabel(baseType)} Playback`;
    const providerType = meta?.providerType ?? baseType;
    const requiresPlayerId = meta?.requiresPlayerId ?? baseType === 'musicassistant';
    return {
      id,
      label,
      baseType,
      providerType,
      requiresPlayerId,
      description: meta?.description ?? '',
    };
  });

  return {
    adapters,
    providers,
    contentPlayers,
  };
}

function buildZoneStatus(zones: ZoneConfigEntry[]) {
  const status: Record<
    number,
    {
      id: number;
      adapterType: string;
      connected: boolean;
      name: string;
      connectError: string;
      sourceLabel?: string;
      sourceKey?: string;
      sourceId?: string;
    }
  > = {};
  for (const zone of zones) {
    const adapterType = normalizeAdapterType(zone?.adapter?.type);
    const state = zoneStateStore.getZoneState(zone.id);
    const connected = Boolean(state && state.power !== AudioPowerState.Off);
    const parentName = typeof state?.parent?.name === 'string' ? state.parent.name.trim() : '';
    const sourceName = typeof state?.sourceName === 'string' ? state.sourceName.trim() : '';
    const sourceLabel = parentName || sourceName || zone.source || '';
    const sourceId =
      typeof state?.parent?.id === 'string'
        ? state.parent.id
        : (typeof zone.sourceSerial === 'string' ? zone.sourceSerial : '');
    let sourceKey = '';
    if (sourceLabel || sourceId) {
      const extIndex = extractExtensionIndex(sourceLabel);
      if (Number.isFinite(extIndex) && extIndex !== null) {
        sourceKey = `extension-${extIndex}`;
      } else if (isAudioServerLabel(sourceLabel)) {
        sourceKey = 'audioserver';
      } else if (sourceId) {
        sourceKey = sourceId.toLowerCase();
      } else if (sourceLabel) {
        sourceKey = sourceLabel.toLowerCase();
      }
    }
    status[zone.id] = {
      id: zone.id,
      adapterType,
      connected,
      name: zone.name ?? '',
      connectError: '',
      sourceLabel,
      sourceKey,
      sourceId,
    };
  }
  return status;
}

function mapZoneStateForAdmin(state: ZoneState) {
  const id = Number(state?.playerid);
  const safeId = Number.isFinite(id) && id > 0 ? id : 0;
  const power = normalizePlaybackString(state?.power);
  const mode = normalizePlaybackString(state?.mode);
  const playbackState = derivePlaybackState(power, mode);
  const connected = isPowerActive(power) || playbackState === 'playing';
  const coverUrl =
    typeof state?.coverurl === 'string' && state.coverurl.trim()
      ? state.coverurl.trim()
      : '';
  const volume = clampVolume(state?.volume);
  const positionMs =
    typeof state?.position_ms === 'number' && Number.isFinite(state.position_ms) && state.position_ms >= 0
      ? Math.floor(state.position_ms)
      : undefined;
  const durationMs =
    typeof state?.duration_ms === 'number' && Number.isFinite(state.duration_ms) && state.duration_ms >= 0
      ? Math.floor(state.duration_ms)
      : typeof state?.duration === 'number' && Number.isFinite(state.duration) && state.duration >= 0
        ? Math.floor(state.duration * 1000)
        : undefined;

  return {
    id: safeId,
    name: typeof state?.name === 'string' ? state.name.trim() : '',
    title: typeof state?.title === 'string' ? state.title.trim() : '',
    artist: typeof state?.artist === 'string' ? state.artist.trim() : '',
    album: typeof state?.album === 'string' ? state.album.trim() : '',
    coverUrl,
    sourceName: typeof state?.sourceName === 'string' ? state.sourceName.trim() : '',
    station: typeof state?.station === 'string' ? state.station.trim() : '',
    power,
    mode,
    state: playbackState,
    volume,
    positionMs: positionMs ?? null,
    durationMs: durationMs ?? null,
    updatedAt: typeof state?.updatedAt === 'number' ? state.updatedAt : null,
    connected,
    parentName: typeof state?.parent?.name === 'string' ? state.parent.name.trim() : '',
    parentId: typeof state?.parent?.id === 'string' ? state.parent.id : '',
  };
}

function normalizePlaybackString(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim().toLowerCase();
  }
  if (value === null) {
    return '';
  }
  return String(value).trim().toLowerCase();
}

function derivePlaybackState(power: string, mode: string): string {
  if (power === AudioPowerState.Off || power === AudioPowerState.Offline) {
    return '';
  }
  if (mode === 'play' || mode === 'resume') {
    return 'playing';
  }
  if (mode === 'pause') {
    return 'paused';
  }
  if (mode === 'stop') {
    return power === 'on' ? 'stopped' : '';
  }
  if (power && power !== 'on') {
    return power;
  }
  if (mode) {
    return mode;
  }
  return '';
}

function isPowerActive(power: string): boolean {
  if (!power) {
    return false;
  }
  return !(
    power === AudioPowerState.Off
    || power === AudioPowerState.Offline
    || power === AudioPowerState.Rebooting
    || power === AudioPowerState.Updating
  );
}

function clampVolume(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function extractExtensionIndex(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const match = value.match(/extension\s*(\d+)/i);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function isAudioServerLabel(label: string | undefined): boolean {
  if (!label) {
    return false;
  }
  const normalized = label.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized.includes('audioserver') || normalized.includes('audio server');
}

function normalizeAdapterConfig(schema: AdapterConfigSchema | undefined) {
  if (!schema || !Array.isArray(schema.fields)) {
    return { fields: [] };
  }
  return {
    fields: schema.fields.map((field) => ({
      ...field,
      inputType: field.inputType,
      required: Boolean(field.required),
      discovery: field.discovery
        ? {
          type: field.discovery.type,
          endpoint: field.discovery.endpoint,
          method: field.discovery.method ?? 'GET',
          requires: Array.isArray(field.discovery.requires)
            ? field.discovery.requires
            : [],
        }
        : undefined,
    })),
  };
}

async function reinitializeRuntimes(): Promise<void> {
  await reinitializeZones();
  await providerRuntime.initialize();
}

async function reinitializeZones(): Promise<void> {
  await zoneRuntime.clearZones();
  await zoneRuntime.initializeZones();
}

function readAppVersion(): string {
  try {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.version === 'string' ? parsed.version : 'dev';
  } catch {
    return 'dev';
  }
}

function broadcastLogEvent(payload: Record<string, unknown>): void {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const [client, heartbeat] of logClients.entries()) {
    try {
      client.write(data);
    } catch {
      clearInterval(heartbeat);
      logClients.delete(client);
    }
  }
}
