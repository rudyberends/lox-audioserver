import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ComponentLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import type { SendspinLineInService } from '@/adapters/inputs/linein/sendspinLineInService';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type {
  AudioServerConfig,
  ZoneConfig,
  ZoneEqualizerConfig,
  ZoneStateConfig,
  ZoneTransportConfig,
} from '@/domain/config/types';
import { defaultMacId, normalizeMacId } from '@/shared/utils/mac';
import { defaultLocalIp } from '@/shared/utils/net';
import type { Route } from '@/adapters/http/adminApi/routeTypes';

export type ConfigHandlerDeps = {
  log: ComponentLogger;
  configPort: ConfigPort;
  contentManager: ContentManager;
  loxoneNotifier: LoxoneWsNotifier;
  sendspinLineInService: SendspinLineInService;
  zoneManager: ZoneManagerFacade;
  readJsonBody: (req: IncomingMessage, res: ServerResponse, maxBytes?: number) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

/** Resolve the primary output for a zone, prefering the explicit `output`
 *  field with a fallback to the legacy `transports[]` shape. */
export function getZoneOutputConfig(zone: {
  output?: ZoneTransportConfig | null;
  transports?: ZoneTransportConfig[];
}): ZoneTransportConfig | null {
  if (zone.output && typeof zone.output === 'object') {
    return zone.output;
  }
  if (Array.isArray(zone.transports) && zone.transports.length > 0) {
    return zone.transports[0] ?? null;
  }
  return null;
}

/** Default config used to seed missing sections during partial updates and
 *  on first run. Used by config/inputs/system/content handlers, and by
 *  spotify/misc handlers when reseeding their respective sections. */
export function defaultConfig(): AudioServerConfig {
  return {
    system: {
      miniserver: { ip: '', serial: '', port: 80, protocol: 'http' },
      audioserver: {
        ip: defaultLocalIp(),
        name: 'Unconfigured',
        uuid: '',
        macId: defaultMacId(),
        paired: false,
        extensions: [],
      },
      logging: {
        consoleLevel: 'none',
        fileLevel: 'none',
      },
      adminHttp: { enabled: true },
    },
    content: {
      radio: {
        tuneInUsername: '',
      },
      spotify: {
        clientId: '',
        accounts: [],
        bridges: [],
      },
      library: {
        enabled: true,
        autoScan: true,
      },
    },
    inputs: {
      airplay: { enabled: true },
      spotify: { enabled: true },
      bluetooth: { enabled: false },
      lineIn: { inputs: [] },
    },
    groups: {
      mixedGroupEnabled: false,
      powerGroups: [],
    },
    zones: [],
    rawAudioConfig: {
      raw: null,
      rawString: null,
      crc32: null,
    },
  };
}

export function buildConfigRoutes(deps: ConfigHandlerDeps): Route[] {
  return [
    { method: 'GET', pattern: /^\/config\/?$/, handler: (_req, res) => handleGetConfig(res, deps) },
    { method: 'POST', pattern: /^\/config\/clear$/, handler: async (_req, res) => handleClear(res, deps) },
    { method: 'POST', pattern: /^\/config\/zones$/, handler: async (req, res) => handleZonesUpdate(req, res, deps) },
    { method: 'POST', pattern: /^\/config\/inputs$/, handler: async (req, res) => handleInputsUpdate(req, res, deps) },
    { method: 'POST', pattern: /^\/config\/system$/, handler: async (req, res) => handleSystemUpdate(req, res, deps) },
    { method: 'POST', pattern: /^\/config\/groups$/, handler: async (req, res) => handleGroupsUpdate(req, res, deps) },
    { method: 'POST', pattern: /^\/config\/content$/, handler: async (req, res) => handleContentUpdate(req, res, deps) },
    { method: 'POST', pattern: /^\/config\/import$/, handler: async (req, res) => handleImport(req, res, deps) },
  ];
}

function handleGetConfig(res: ServerResponse, deps: ConfigHandlerDeps): void {
  const cfg = deps.configPort.getConfig();
  const snapshot = buildAdminConfigSnapshot(cfg);
  deps.sendJson(res, 200, { config: snapshot });
}

async function handleClear(res: ServerResponse, deps: ConfigHandlerDeps): Promise<void> {
  const currentMacId = deps.configPort.getConfig()?.system?.audioserver?.macId;
  await deps.configPort.updateConfig((cfg) => {
    Object.assign(cfg, defaultConfig());
    if (currentMacId) {
      cfg.system.audioserver.macId = currentMacId;
    }
  });
  await reloadZones(deps);
  deps.sendJson(res, 204, {});
}

async function handleZonesUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConfigHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as { zones?: Partial<AudioServerConfig['zones']> } | null;
  if (res.writableEnded) {
    return;
  }
  if (!body?.zones || !Array.isArray(body.zones)) {
    deps.sendJson(res, 400, { error: 'invalid-zones-payload' });
    return;
  }
  const updatedIds = Array.from(
    new Set(
      body.zones
        .map((z) => Number(z?.id))
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  );

  await deps.configPort.updateConfig((cfg) => {
    if (!cfg.zones) cfg.zones = [];
    body.zones!.forEach((incoming) => {
      if (!incoming) return;
      const target = cfg.zones!.find((z) => z.id === incoming.id);
      if (target) {
        if (incoming.inputs !== undefined) {
          target.inputs = incoming.inputs;
        }
        if (incoming.powerManager !== undefined) {
          target.powerManager = incoming.powerManager;
        }
        if (incoming.equalizer !== undefined) {
          target.equalizer = normalizeEqualizerPayload(target.equalizer, incoming.equalizer);
        }
        if (incoming.state !== undefined) {
          target.state = normalizeZoneStatePayload(incoming.state);
        }
        if (incoming.name !== undefined) target.name = incoming.name;
        if (incoming.source !== undefined) target.source = incoming.source;
        if (incoming.sourceSerial !== undefined) target.sourceSerial = incoming.sourceSerial;
        if (
          incoming.output !== undefined ||
          (incoming as { transport?: unknown }).transport !== undefined ||
          incoming.transports !== undefined
        ) {
          target.output = normalizeOutputPayload(incoming);
          delete target.transports;
        }
      } else {
        const nextZone = { ...incoming } as ZoneConfig & { transport?: unknown };
        if (
          incoming.output !== undefined ||
          (incoming as { transport?: unknown }).transport !== undefined ||
          incoming.transports !== undefined
        ) {
          nextZone.output = normalizeOutputPayload(incoming);
          delete nextZone.transport;
          delete nextZone.transports;
        }
        if (incoming.state !== undefined) {
          nextZone.state = normalizeZoneStatePayload(incoming.state);
        }
        if (incoming.powerManager !== undefined) {
          nextZone.powerManager = incoming.powerManager;
        }
        if (incoming.equalizer !== undefined) {
          nextZone.equalizer = normalizeEqualizerPayload(undefined, incoming.equalizer);
        }
        cfg.zones!.push(nextZone as ZoneConfig);
      }
    });
  });
  await reloadZones(deps, updatedIds);
  deps.sendJson(res, 204, {});
}

async function handleInputsUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConfigHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as
    | {
        airplay?: { enabled?: boolean };
        spotify?: { enabled?: boolean };
        bluetooth?: { enabled?: boolean };
        lineIn?: { inputs?: Array<Record<string, unknown>> | null };
      }
    | null;
  if (res.writableEnded) {
    return;
  }
  if (!body || typeof body !== 'object') {
    deps.sendJson(res, 400, { error: 'invalid-inputs-payload' });
    return;
  }

  const lineInUpdated =
    typeof body.lineIn === 'object' &&
    body.lineIn !== null &&
    Object.prototype.hasOwnProperty.call(body.lineIn, 'inputs');
  const lineInInputs = lineInUpdated
    ? Array.isArray(body.lineIn?.inputs)
      ? body.lineIn?.inputs
      : []
    : null;

  await deps.configPort.updateConfig((cfg) => {
    if (!cfg.inputs) cfg.inputs = defaultConfig().inputs;
    if (body.airplay && typeof body.airplay === 'object' && 'enabled' in body.airplay) {
      cfg.inputs!.airplay = { ...(cfg.inputs!.airplay ?? {}), enabled: Boolean(body.airplay.enabled) };
    }
    if (body.spotify && typeof body.spotify === 'object' && 'enabled' in body.spotify) {
      cfg.inputs!.spotify = { ...(cfg.inputs!.spotify ?? {}), enabled: Boolean(body.spotify.enabled) };
    }
    if (body.bluetooth && typeof body.bluetooth === 'object' && 'enabled' in body.bluetooth) {
      cfg.inputs!.bluetooth = {
        ...(cfg.inputs!.bluetooth ?? {}),
        enabled: Boolean(body.bluetooth.enabled),
      };
    }
    if (lineInUpdated) {
      cfg.inputs!.lineIn = { ...(cfg.inputs!.lineIn ?? {}), inputs: lineInInputs ?? [] };
    }
  });
  if (lineInUpdated) {
    deps.loxoneNotifier.notifyLineInChanged();
    deps.sendspinLineInService.refresh();
  }
  await reloadZones(deps);
  deps.sendJson(res, 204, {});
}

async function handleSystemUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConfigHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as
    | {
        audioserver?: { macId?: string; ip?: string; authEnabled?: boolean };
        miniserver?: { ip?: string; port?: number; protocol?: 'http' | 'https' };
      }
    | null;
  if (res.writableEnded) {
    return;
  }
  if (!body || typeof body !== 'object') {
    deps.sendJson(res, 400, { error: 'invalid-system-payload' });
    return;
  }
  const hasAudioserver = body.audioserver && typeof body.audioserver === 'object';
  const hasMiniserver = body.miniserver && typeof body.miniserver === 'object';
  if (!hasAudioserver && !hasMiniserver) {
    deps.sendJson(res, 400, { error: 'invalid-system-payload' });
    return;
  }

  const rawMac = hasAudioserver ? body.audioserver!.macId : undefined;
  const rawIp = hasAudioserver ? body.audioserver!.ip : undefined;
  const rawAuthEnabled = hasAudioserver ? body.audioserver!.authEnabled : undefined;
  const rawMiniserverIp = hasMiniserver ? body.miniserver!.ip : undefined;
  const rawMiniserverPort = hasMiniserver ? body.miniserver!.port : undefined;
  const rawMiniserverProtocol = hasMiniserver ? body.miniserver!.protocol : undefined;
  if (
    typeof rawMac !== 'string' &&
    typeof rawIp !== 'string' &&
    typeof rawAuthEnabled !== 'boolean' &&
    typeof rawMiniserverIp !== 'string' &&
    typeof rawMiniserverPort !== 'number' &&
    typeof rawMiniserverProtocol !== 'string'
  ) {
    deps.sendJson(res, 400, { error: 'invalid-system-payload' });
    return;
  }

  let normalizedMac: string | null = null;
  if (typeof rawMac === 'string') {
    const trimmed = rawMac.trim();
    if (!trimmed) {
      deps.sendJson(res, 400, { error: 'invalid-macid' });
      return;
    }
    const normalized = normalizeMacId(trimmed);
    if (!normalized || normalized.length !== 12) {
      deps.sendJson(res, 400, { error: 'invalid-macid' });
      return;
    }
    normalizedMac = normalized;
  }
  let normalizedIp: string | null = null;
  if (typeof rawIp === 'string') {
    const trimmedIp = rawIp.trim();
    if (!trimmedIp) {
      deps.sendJson(res, 400, { error: 'invalid-ip' });
      return;
    }
    normalizedIp = trimmedIp;
  }
  let normalizedMiniserverIp: string | null = null;
  if (typeof rawMiniserverIp === 'string') {
    const trimmedIp = rawMiniserverIp.trim();
    if (!trimmedIp) {
      deps.sendJson(res, 400, { error: 'invalid-miniserver-ip' });
      return;
    }
    normalizedMiniserverIp = trimmedIp;
  }
  let normalizedMiniserverPort: number | null = null;
  if (typeof rawMiniserverPort === 'number') {
    if (
      !Number.isInteger(rawMiniserverPort) ||
      rawMiniserverPort <= 0 ||
      rawMiniserverPort > 65535
    ) {
      deps.sendJson(res, 400, { error: 'invalid-miniserver-port' });
      return;
    }
    normalizedMiniserverPort = rawMiniserverPort;
  }
  let normalizedMiniserverProtocol: 'http' | 'https' | null = null;
  if (typeof rawMiniserverProtocol === 'string') {
    const value = rawMiniserverProtocol.trim().toLowerCase();
    if (value !== 'http' && value !== 'https') {
      deps.sendJson(res, 400, { error: 'invalid-miniserver-protocol' });
      return;
    }
    normalizedMiniserverProtocol = value;
  }
  await deps.configPort.updateConfig((cfg) => {
    if (!cfg.system) cfg.system = defaultConfig().system;
    if (!cfg.system.audioserver) {
      cfg.system.audioserver = defaultConfig().system.audioserver;
    }
    if (!cfg.system.miniserver) {
      cfg.system.miniserver = defaultConfig().system.miniserver;
    }
    if (normalizedMac) {
      cfg.system.audioserver.macId = normalizedMac;
    }
    if (normalizedIp) {
      cfg.system.audioserver.ip = normalizedIp;
    }
    if (typeof rawAuthEnabled === 'boolean') {
      cfg.system.audioserver.authEnabled = rawAuthEnabled;
    }
    if (normalizedMiniserverIp) {
      cfg.system.miniserver.ip = normalizedMiniserverIp;
    }
    if (normalizedMiniserverPort !== null) {
      cfg.system.miniserver.port = normalizedMiniserverPort;
    }
    if (normalizedMiniserverProtocol) {
      cfg.system.miniserver.protocol = normalizedMiniserverProtocol;
    }
  });
  deps.sendJson(res, 204, {});
}

async function handleGroupsUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConfigHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as
    | {
        mixedGroupEnabled?: boolean;
        powerGroups?: AudioServerConfig['groups'] extends infer G
          ? G extends { powerGroups?: infer P }
            ? P
            : never
          : never;
      }
    | null;
  if (res.writableEnded) {
    return;
  }
  if (!body || typeof body !== 'object') {
    deps.sendJson(res, 400, { error: 'invalid-groups-payload' });
    return;
  }
  if (!('mixedGroupEnabled' in body) && !('powerGroups' in body)) {
    deps.sendJson(res, 400, { error: 'invalid-groups-payload' });
    return;
  }
  await deps.configPort.updateConfig((cfg) => {
    if (!cfg.groups) cfg.groups = {};
    if ('mixedGroupEnabled' in body) {
      cfg.groups.mixedGroupEnabled = Boolean(body.mixedGroupEnabled);
    }
    if ('powerGroups' in body) {
      cfg.groups.powerGroups = Array.isArray(body.powerGroups) ? body.powerGroups : [];
    }
  });
  deps.sendJson(res, 204, {});
}

async function handleContentUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConfigHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as
    | {
        radio?: { tuneInUsername?: string | null };
        spotify?: { clientId?: string | null; cacheEnabled?: boolean; cacheSizeMb?: number };
        library?: { enabled?: boolean; autoScan?: boolean };
        tts?: AudioServerConfig['content']['tts'];
      }
    | null;
  if (res.writableEnded) {
    return;
  }
  if (!body || typeof body !== 'object') {
    deps.sendJson(res, 400, { error: 'invalid-content-payload' });
    return;
  }

  await deps.configPort.updateConfig((cfg) => {
    if (!cfg.content) cfg.content = defaultConfig().content;
    if (body.radio) {
      cfg.content.radio = {
        ...(cfg.content.radio ?? {}),
        tuneInUsername:
          typeof body.radio.tuneInUsername === 'string'
            ? body.radio.tuneInUsername.trim()
            : '',
      };
    }
    if (body.spotify) {
      cfg.content.spotify = {
        ...(cfg.content.spotify ?? { accounts: [], bridges: [] }),
        clientId:
          typeof body.spotify.clientId === 'string'
            ? body.spotify.clientId.trim()
            : '',
        accounts: cfg.content.spotify?.accounts ?? [],
        bridges: cfg.content.spotify?.bridges ?? [],
        ...(typeof body.spotify.cacheEnabled === 'boolean' && { cacheEnabled: body.spotify.cacheEnabled }),
        ...(typeof body.spotify.cacheSizeMb === 'number' && { cacheSizeMb: body.spotify.cacheSizeMb }),
      };
    }
    if (body.library) {
      cfg.content.library = {
        ...(cfg.content.library ?? {}),
        ...body.library,
      };
    }
    if (body.tts) {
      cfg.content.tts = {
        ...(cfg.content.tts ?? { provider: { type: 'internal' }, fallbackToInternal: true }),
        ...body.tts,
      };
    }
  });
  deps.contentManager.refreshFromConfig();
  deps.sendJson(res, 204, {});
}

async function handleImport(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConfigHandlerDeps,
): Promise<void> {
  const body = await deps.readJsonBody(req, res);
  if (res.writableEnded) {
    return;
  }
  if (!body || typeof body !== 'object') {
    deps.sendJson(res, 400, { error: 'invalid-config' });
    return;
  }

  await deps.configPort.updateConfig((cfg) => {
    Object.assign(cfg, body as Partial<AudioServerConfig>);
  });
  await reloadZones(deps);
  deps.sendJson(res, 204, {});
}

// ---- Helpers ----

async function reloadZones(deps: ConfigHandlerDeps, zoneIds?: number[]): Promise<void> {
  const cfg = deps.configPort.getConfig();
  if (!zoneIds || zoneIds.length === 0) {
    await deps.zoneManager.replaceAll(cfg.zones ?? [], cfg.inputs ?? null, cfg.groups ?? null);
    return;
  }
  const set = new Set(zoneIds);
  const targets = (cfg.zones ?? []).filter((z) => set.has(z.id));
  if (targets.length === 0) {
    await deps.zoneManager.replaceAll(cfg.zones ?? [], cfg.inputs ?? null, cfg.groups ?? null);
    return;
  }
  await deps.zoneManager.replaceZones(targets, cfg.inputs ?? null, cfg.groups ?? null);
}

function buildAdminConfigSnapshot(config: AudioServerConfig): AudioServerConfig {
  const zones = (config.zones ?? []).map((zone) => {
    const primaryOutput = getZoneOutputConfig(zone);
    const transports = primaryOutput ? [primaryOutput] : [];
    const state = normalizeZoneStatePayload((zone as { state?: unknown }).state);
    const { output: _output, transports: _transports, ...rest } = zone as ZoneConfig & Record<string, unknown>;
    return { ...rest, transports, state };
  });
  return { ...config, zones };
}

function normalizeOutputPayload(payload: unknown): ZoneTransportConfig | null {
  const p = payload as { output?: unknown; transport?: unknown; transports?: unknown } | null;
  if (p?.output === null || p?.transport === null) {
    return null;
  }
  if (p?.output && typeof p.output === 'object') {
    return p.output as ZoneTransportConfig;
  }
  if (p?.transport && typeof p.transport === 'object') {
    return p.transport as ZoneTransportConfig;
  }
  if (Array.isArray(p?.transports)) {
    return (p.transports[0] as ZoneTransportConfig | undefined) ?? null;
  }
  return null;
}

function normalizeEqualizerPayload(
  current: ZoneEqualizerConfig | null | undefined,
  payload: unknown,
): ZoneEqualizerConfig | null {
  if (payload === null) {
    const bands = current?.bands;
    return bands && Array.isArray(bands) && bands.length > 0 ? { bands: [...bands] } : null;
  }
  if (!payload || typeof payload !== 'object') {
    return current ?? null;
  }
  const record = payload as Record<string, unknown>;
  const next: ZoneEqualizerConfig = {};
  if (Array.isArray(current?.bands)) {
    next.bands = [...current!.bands!];
  }
  if (Array.isArray(record.bands)) {
    next.bands = record.bands.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry));
  }
  if (record.provider !== undefined) {
    const provider = String(record.provider).trim().toLowerCase();
    if (provider === 'squeezelite-mr') {
      next.provider = 'squeezelite-mr';
    } else if (provider === 'builtin') {
      next.provider = 'builtin';
    }
    // 'off' / unknown: omit field for compact persisted config.
  } else if (current?.provider) {
    next.provider = current.provider;
  }
  if (record.callbackUrl !== undefined) {
    const raw = typeof record.callbackUrl === 'string' ? record.callbackUrl.trim() : '';
    if (raw) next.callbackUrl = raw;
  } else if (current?.callbackUrl) {
    next.callbackUrl = current.callbackUrl;
  }
  // callbackUrl only makes sense for the squeezelite-mr forwarder.
  if (next.provider !== 'squeezelite-mr') {
    delete next.callbackUrl;
  }
  return Object.keys(next).length > 0 ? next : null;
}

function normalizeZoneStatePayload(payload: unknown): ZoneStateConfig {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const controllerRaw = typeof record.controller === 'string' ? record.controller.trim().toLowerCase() : '';
    const normalized = controllerRaw.replace(/[\s_-]+/g, '');
    const controller =
      normalized === 'beolink'
        ? 'beolink'
        : normalized === 'sonos'
          ? 'sonos'
          : 'internal';
    return {
      ...record,
      controller,
    };
  }
  return { controller: 'internal' };
}
