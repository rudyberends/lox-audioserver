import type { IncomingMessage, ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import type { ComponentLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { MdnsPort, MdnsServiceRecord } from '@/ports/MdnsPort';
import type { SnapcastCore } from '@/adapters/outputs/snapcast/snapcastCore';
import type { SqueezeliteCore } from '@/adapters/outputs/squeezelite/squeezeliteCore';
import type { MusicAssistantStreamService } from '@/adapters/inputs/musicassistant/musicAssistantStreamService';
import type { SpotifyServiceManagerProvider } from '@/adapters/content/providers/spotifyServiceManager';
import { sendspinCore } from '@lox-audioserver/node-sendspin';
import { OUTPUT_DEFINITIONS } from '@/adapters/outputs';
import { discoverAirplayDevices } from '@/adapters/outputs/airplay/airplayDiscovery';
import { discoverGoogleCastDevices } from '@/adapters/outputs/googleCast/googleCastDiscovery';
import { discoverDlnaDevices } from '@/adapters/outputs/dlna/dlnaDiscovery';
import { discoverSonosDevices } from '@/adapters/outputs/sonos/sonosDiscovery';
import { discoverSpotifyConnectDevices } from '@/adapters/content/providers/spotify/spotifyConnectDiscovery';
import type { Route } from '@/adapters/http/adminApi/routeTypes';

const HIDDEN_TRANSPORT_IDS = new Set(['spotify', 'sendspin-cast', 'dlna']);

export type StateControllerDefinition = {
  id: string;
  label: string;
  description: string;
};

export type TransportsHandlerDeps = {
  log: ComponentLogger;
  configPort: ConfigPort;
  mdns: MdnsPort;
  snapcastCore: SnapcastCore;
  squeezeliteCore: SqueezeliteCore;
  musicAssistantStreamService: MusicAssistantStreamService;
  spotifyManagerProvider: SpotifyServiceManagerProvider;
  stateControllerDefinitions: readonly StateControllerDefinition[];
  readJsonBody: (req: IncomingMessage, res: ServerResponse, maxBytes?: number) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

export function buildTransportsRoutes(deps: TransportsHandlerDeps): Route[] {
  return [
    { method: 'GET', pattern: /^\/transports$/, handler: (_req, res) => handleTransportDefinitions(res, deps) },
    {
      method: 'GET',
      pattern: /^\/transports\/airplay\/devices$/,
      handler: async (_req, res) => handleAirplayDiscovery(res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/transports\/googlecast\/devices$/,
      handler: async (req, res) => handleGoogleCastDiscovery(req, res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/transports\/dlna\/devices$/,
      handler: async (req, res) => handleDlnaDiscovery(req, res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/transports\/sonos\/devices$/,
      handler: async (req, res) => handleSonosDiscovery(req, res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/transports\/musicassistant\/devices$/,
      handler: async (_req, res) => handleMusicAssistantPlayerDiscovery(res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/transports\/musicassistant\/status$/,
      handler: async (_req, res) => handleMusicAssistantStatus(res, deps),
    },
    {
      method: 'POST',
      pattern: /^\/transports\/ping$/,
      handler: async (req, res) => handleTransportPing(req, res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/transports\/sendspin\/clients$/,
      handler: async (req, res) => handleSendspinDiscovery(req, res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/transports\/sendspin\/mdns-clients$/,
      handler: async (req, res) => handleSendspinMdnsDiscovery(req, res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/transports\/sendspin\/sources$/,
      handler: async (_req, res) => handleSendspinSourceDiscovery(res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/transports\/snapcast\/clients$/,
      handler: async (_req, res) => handleSnapcastDiscovery(res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/transports\/squeezelite\/clients$/,
      handler: async (_req, res) => handleSqueezeliteDiscovery(res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/transports\/spotify\/devices$/,
      handler: async (_req, res) => handleSpotifyDeviceDiscovery(res, deps),
    },
  ];
}

function handleTransportDefinitions(res: ServerResponse, deps: TransportsHandlerDeps): void {
  const payload = OUTPUT_DEFINITIONS.filter(
    (definition) => !HIDDEN_TRANSPORT_IDS.has(definition.id),
  ).map((definition) => ({
    id: definition.id,
    label: definition.label,
    description: definition.description ?? '',
    fields: definition.fields.map((field) => ({
      id: field.id,
      label: field.label,
      type: field.type,
      placeholder: field.placeholder ?? '',
      description: field.description ?? '',
      required: field.required ?? false,
    })),
  }));
  deps.sendJson(res, 200, { transports: payload, stateControllers: deps.stateControllerDefinitions });
}

async function handleAirplayDiscovery(res: ServerResponse, deps: TransportsHandlerDeps): Promise<void> {
  try {
    const devices = await discoverAirplayDevices();
    deps.sendJson(res, 200, { devices });
  } catch (err) {
    deps.log.warn('airplay discovery failed', { err });
    deps.sendJson(res, 500, { error: 'airplay-discovery-failed' });
  }
}

async function handleGoogleCastDiscovery(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TransportsHandlerDeps,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '', 'http://localhost');
    const hosts = url.searchParams
      .getAll('host')
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const devices = await discoverGoogleCastDevices(8000, hosts);
    deps.sendJson(res, 200, { devices });
  } catch (err) {
    deps.log.warn('google cast discovery failed', { err });
    deps.sendJson(res, 500, { error: 'googlecast-discovery-failed' });
  }
}

async function handleDlnaDiscovery(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TransportsHandlerDeps,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '', 'http://localhost');
    const host = url.searchParams.get('host')?.trim() || undefined;
    const devices = await discoverDlnaDevices({ host });
    deps.sendJson(res, 200, { devices });
  } catch (err) {
    deps.log.warn('dlna discovery failed', { err });
    deps.sendJson(res, 500, { error: 'dlna-discovery-failed' });
  }
}

async function handleSonosDiscovery(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TransportsHandlerDeps,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '', 'http://localhost');
    const preferredName = url.searchParams.get('name')?.trim() || undefined;
    const householdId = url.searchParams.get('householdId')?.trim() || undefined;
    const activeHost = url.searchParams.get('host')?.trim() || undefined;
    const networkScan = url.searchParams.get('networkScan')?.trim();
    const allowNetworkScan =
      typeof networkScan === 'string' &&
      ['true', '1', 'yes', 'on'].includes(networkScan.toLowerCase());
    const devices = await discoverSonosDevices({
      preferredName,
      householdId,
      allowNetworkScan,
    });
    const payload = devices.map((device) => ({
      id: device.udn || device.host,
      host: device.host,
      name: device.name ?? device.roomName,
      roomName: device.roomName,
      householdId: device.householdId,
      active: activeHost ? device.host === activeHost : undefined,
    }));
    deps.sendJson(res, 200, { devices: payload });
  } catch (err) {
    deps.log.warn('sonos discovery failed', { err });
    deps.sendJson(res, 500, { error: 'sonos-discovery-failed' });
  }
}

async function handleMusicAssistantPlayerDiscovery(
  res: ServerResponse,
  deps: TransportsHandlerDeps,
): Promise<void> {
  try {
    const raw = await deps.musicAssistantStreamService.listPlayers();
    const devices = raw
      .map((player) => {
        const id = (player.player_id || player.id || '').trim();
        const name = (player.name || id || '').trim();
        if (!id) return null;
        return { id, deviceId: id, name: name || id };
      })
      .filter(Boolean);
    deps.sendJson(res, 200, { devices });
  } catch (err) {
    deps.log.warn('music assistant player discovery failed', { err });
    deps.sendJson(res, 500, { error: 'musicassistant-discovery-failed' });
  }
}

async function handleMusicAssistantStatus(
  res: ServerResponse,
  deps: TransportsHandlerDeps,
): Promise<void> {
  try {
    const status = await deps.musicAssistantStreamService.testConnection();
    deps.sendJson(res, 200, status);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log.warn('music assistant status failed', { message });
    deps.sendJson(res, 500, { ok: false, error: 'musicassistant-status-failed', message });
  }
}

async function handleTransportPing(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TransportsHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as { host?: string; port?: number } | null;
  if (res.writableEnded) {
    return;
  }
  const host = body?.host?.trim();
  const rawPort = body?.port;
  const port =
    typeof rawPort === 'number' && Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535
      ? rawPort
      : 80;
  if (!host) {
    deps.sendJson(res, 400, { error: 'invalid-host' });
    return;
  }

  try {
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host, port, timeout: 1500 }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
    deps.sendJson(res, 200, { reachable });
  } catch (err) {
    deps.log.warn('transport ping failed', { err, host, port });
    deps.sendJson(res, 500, { error: 'transport-ping-failed' });
  }
}

async function handleSendspinDiscovery(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TransportsHandlerDeps,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '', 'http://localhost');
    const roles = url.searchParams
      .getAll('role')
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const connected = sendspinCore
      .listClients()
      .filter((client) => (roles.length ? roles.some((role) => client.roles.includes(role)) : true))
      .filter((client) => typeof client.clientId === 'string' && client.clientId.trim().length > 0)
      .map((client) => {
        const clientId = client.clientId;
        const controls = clientId
          ? sendspinCore.getSessionByClientId(clientId)?.getSourceSupport()?.controls ?? null
          : null;
        return {
          id: client.clientId,
          clientId: client.clientId,
          name: client.name || client.clientId,
          // Legacy fields (kept for backwards compatibility).
          remote: client.remote,
          roles: client.roles,
          playbackState: client.playbackState,
          // UI-friendly fields.
          address: client.remote ?? undefined,
          sourceState: client.sourceState,
          sourceSignal: client.sourceSignal,
          controls,
        };
      });

    if (roles.length > 0) {
      deps.sendJson(res, 200, { clients: connected });
      return;
    }

    const mdnsTimeoutMsRaw = url.searchParams.get('mdnsTimeoutMs');
    const mdnsTimeoutMsParsed = mdnsTimeoutMsRaw ? Number(mdnsTimeoutMsRaw) : null;
    const mdnsTimeoutMs =
      typeof mdnsTimeoutMsParsed === 'number' && Number.isFinite(mdnsTimeoutMsParsed) && mdnsTimeoutMsParsed > 0
        ? Math.min(15_000, Math.max(250, Math.round(mdnsTimeoutMsParsed)))
        : 1_500;

    const discovered = await discoverMdnsServices(deps.mdns, { type: 'sendspin', protocol: 'tcp' }, mdnsTimeoutMs);
    const mdnsClients = discovered
      .map((service) => mapSendspinMdnsService(service))
      .filter((entry) => entry !== null)
      .map((entry) => ({
        id: entry.id,
        clientId: entry.name ?? entry.addresses[0] ?? entry.host ?? entry.id,
        name: entry.name ?? entry.addresses[0] ?? entry.host ?? entry.id,
        host: entry.host ?? undefined,
        address: entry.addresses[0] ?? entry.host ?? undefined,
        port: entry.port,
        path: entry.path,
        controls: null,
        sourceState: null,
        sourceSignal: null,
      }));

    const byClientId = new Set<string>();
    connected.forEach((c) => {
      if (typeof c.clientId === 'string') byClientId.add(c.clientId);
    });
    const merged = [...connected];
    for (const client of mdnsClients) {
      if (!byClientId.has(client.clientId)) {
        merged.push(client as any);
      }
    }

    deps.sendJson(res, 200, { clients: merged });
  } catch (err) {
    deps.log.warn('sendspin discovery failed', { err });
    deps.sendJson(res, 500, { error: 'sendspin-discovery-failed' });
  }
}

async function handleSendspinMdnsDiscovery(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TransportsHandlerDeps,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '', 'http://localhost');
    const timeoutMsRaw = url.searchParams.get('timeoutMs');
    const timeoutMsParsed = timeoutMsRaw ? Number(timeoutMsRaw) : null;
    const timeoutMs =
      typeof timeoutMsParsed === 'number' && Number.isFinite(timeoutMsParsed) && timeoutMsParsed > 0
        ? Math.min(15_000, Math.max(250, Math.round(timeoutMsParsed)))
        : 3_000;

    const discovered = await discoverMdnsServices(deps.mdns, { type: 'sendspin', protocol: 'tcp' }, timeoutMs);
    const clients = discovered
      .map((service) => mapSendspinMdnsService(service))
      .filter((entry) => entry !== null);

    deps.sendJson(res, 200, { clients, timeoutMs });
  } catch (err) {
    deps.log.warn('sendspin mdns discovery failed', { err });
    deps.sendJson(res, 500, { error: 'sendspin-mdns-discovery-failed' });
  }
}

async function handleSendspinSourceDiscovery(
  res: ServerResponse,
  deps: TransportsHandlerDeps,
): Promise<void> {
  try {
    const clients = sendspinCore
      .listClients()
      .filter((client) => client.roles.includes('source@v1'))
      .map((client) => {
        const clientId = client.clientId;
        const controls = clientId
          ? sendspinCore.getSessionByClientId(clientId)?.getSourceSupport()?.controls ?? null
          : null;
        return {
          id: client.clientId,
          clientId: client.clientId,
          name: client.name,
          remote: client.remote,
          roles: client.roles,
          playbackState: client.playbackState,
          sourceState: client.sourceState,
          sourceSignal: client.sourceSignal,
          controls,
        };
      });
    deps.sendJson(res, 200, { clients });
  } catch (err) {
    deps.log.warn('sendspin source discovery failed', { err });
    deps.sendJson(res, 500, { error: 'sendspin-source-discovery-failed' });
  }
}

function handleSnapcastDiscovery(res: ServerResponse, deps: TransportsHandlerDeps): void {
  try {
    const clients = deps.snapcastCore.listClients().map((client) => ({
      id: client.clientId || client.streamId,
      clientId: client.clientId,
      streamId: client.streamId,
      connected: client.connected,
      connectedAt: client.connectedAt,
      latency: client.latency,
    }));
    deps.sendJson(res, 200, { clients });
  } catch (err) {
    deps.log.warn('snapcast discovery failed', { err });
    deps.sendJson(res, 500, { error: 'snapcast-discovery-failed' });
  }
}

function handleSqueezeliteDiscovery(res: ServerResponse, deps: TransportsHandlerDeps): void {
  try {
    const cfg = deps.configPort.getConfig();
    const configuredByPlayerId = new Map<
      string,
      { zoneId: number; zoneName: string; latencyMs: number | null }
    >();
    (cfg.zones ?? []).forEach((zone) => {
      const output = zone.output;
      if (!output || typeof output !== 'object') return;
      if (output.id !== 'squeezelite') return;
      const out = output as { playerId?: unknown; latencyMs?: unknown };
      const rawPlayerId = typeof out.playerId === 'string' ? out.playerId : '';
      const normalized = normalizeSqueezelitePlayerId(rawPlayerId);
      if (!normalized) return;
      const rawLatency = out.latencyMs;
      const parsedLatency =
        typeof rawLatency === 'number'
          ? rawLatency
          : typeof rawLatency === 'string'
            ? Number(rawLatency)
            : null;
      const latencyMs = typeof parsedLatency === 'number' && Number.isFinite(parsedLatency)
        ? Math.round(parsedLatency)
        : null;
      configuredByPlayerId.set(normalized, { zoneId: zone.id, zoneName: zone.name, latencyMs });
    });

    const clients = deps.squeezeliteCore.players.map((player) => ({
      id: player.playerId,
      playerId: player.playerId,
      name: player.name,
      address: player.deviceAddress ?? null,
      port: player.devicePort ?? null,
      state: player.state,
      connected: player.connected,
      zoneId: configuredByPlayerId.get(normalizeSqueezelitePlayerId(player.playerId))?.zoneId ?? null,
      zoneName: configuredByPlayerId.get(normalizeSqueezelitePlayerId(player.playerId))?.zoneName ?? null,
      latency: configuredByPlayerId.get(normalizeSqueezelitePlayerId(player.playerId))?.latencyMs ?? null,
      latencyMs: configuredByPlayerId.get(normalizeSqueezelitePlayerId(player.playerId))?.latencyMs ?? null,
    }));
    deps.sendJson(res, 200, { clients });
  } catch (err) {
    deps.log.warn('squeezelite discovery failed', { err });
    deps.sendJson(res, 500, { error: 'squeezelite-discovery-failed' });
  }
}

async function handleSpotifyDeviceDiscovery(
  res: ServerResponse,
  deps: TransportsHandlerDeps,
): Promise<void> {
  try {
    const devices = await discoverSpotifyConnectDevices(deps.spotifyManagerProvider);
    deps.sendJson(res, 200, { devices });
  } catch (err) {
    deps.log.warn('spotify device discovery failed', { err });
    deps.sendJson(res, 500, { error: 'spotify-discovery-failed' });
  }
}

function discoverMdnsServices(
  mdns: MdnsPort,
  options: { type: string; protocol?: 'tcp' | 'udp' },
  timeoutMs: number,
): Promise<MdnsServiceRecord[]> {
  return new Promise((resolve) => {
    const byKey = new Map<string, MdnsServiceRecord>();
    const browser = mdns.browse({ type: options.type, protocol: options.protocol ?? 'tcp' }, (service) => {
      const key = `${service.name || service.host || (service.addresses?.[0] ?? 'unknown')}:${service.port}`;
      byKey.set(key, service);
    });
    setTimeout(() => {
      browser.stop();
      resolve([...byKey.values()]);
    }, timeoutMs);
  });
}

function mapSendspinMdnsService(
  service: MdnsServiceRecord,
): {
  id: string;
  name: string | null;
  host: string | null;
  addresses: string[];
  port: number;
  path: string;
  url: string;
  txt: Record<string, unknown> | null;
} | null {
  if (!service.port) {
    return null;
  }

  const addresses = (service.addresses || []).filter(Boolean) as string[];
  const pickAddress = (): string | null => {
    const ipv4 = addresses.find((addr) => addr.includes('.'));
    if (ipv4) return ipv4;
    if (addresses.length) return addresses[0] ?? null;
    if (typeof service.host === 'string' && service.host.trim()) return service.host.trim();
    return null;
  };

  const address = pickAddress();
  if (!address) {
    return null;
  }

  const txt = service.txt && typeof service.txt === 'object' ? (service.txt as Record<string, unknown>) : null;
  const rawPath = typeof txt?.path === 'string' ? txt.path : '/sendspin';
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const hostFmt = address.includes(':') ? `[${address}]` : address;
  const url = `ws://${hostFmt}:${service.port}${path || '/sendspin'}`;
  const name = typeof service.name === 'string' && service.name.trim() ? service.name.trim() : null;

  return {
    id: `${name ?? address}:${service.port}`,
    name,
    host: typeof service.host === 'string' && service.host.trim() ? service.host.trim() : null,
    addresses,
    port: service.port,
    path: path || '/sendspin',
    url,
    txt,
  };
}

function normalizeSqueezelitePlayerId(value: string): string {
  if (!value) return '';
  return value.replace(/[^a-f0-9]/gi, '').toLowerCase();
}
