import { createLogger } from '@/shared/logging/logger';
import type { ZoneConfig, ZoneTransportConfig } from '@/domain/config/types';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import {
  DlnaOutput,
  DLNA_OUTPUT_DEFINITION,
} from '@/adapters/outputs/dlna/dlnaOutput';
import {
  SpotifyConnectInputController,
  SPOTIFY_CONNECT_CONTROLLER_DEFINITION,
} from '@/adapters/inputs/spotify/spotifyConnectController';
import {
  AirPlayOutput,
  AIRPLAY_OUTPUT_DEFINITION,
  type AirPlayOutputConfig,
} from '@/adapters/outputs/airplay/airplayOutput';
import {
  SnapcastOutput,
  SNAPCAST_OUTPUT_DEFINITION,
  type SnapcastOutputConfig,
} from '@/adapters/outputs/snapcast/snapcastOutput';
import {
  SendspinOutput,
  SENDSPIN_OUTPUT_DEFINITION,
  type SendspinOutputConfig,
} from '@/adapters/outputs/sendspin/sendspinOutput';
import {
  GoogleCastOutput,
  GOOGLE_CAST_OUTPUT_DEFINITION,
  type GoogleCastOutputConfig,
} from '@/adapters/outputs/googleCast/googleCastOutput';
import {
  SendspinCastOutput,
  SENDSPIN_CAST_OUTPUT_DEFINITION,
  type SendspinCastOutputConfig,
} from '@/adapters/outputs/googleCast/sendspinCastOutput';
import {
  SnapcastCastOutput,
  SNAPCAST_CAST_OUTPUT_DEFINITION,
  type SnapcastCastOutputConfig,
} from '@/adapters/outputs/googleCast/snapcastCastOutput';
import {
  SonosOutput,
  SONOS_OUTPUT_DEFINITION,
  type SonosOutputConfig,
} from '@/adapters/outputs/sonos/sonosOutput';
import {
  SqueezeliteOutput,
  SQUEEZELITE_OUTPUT_DEFINITION,
  type SqueezeliteOutputConfig,
} from '@/adapters/outputs/squeezelite/squeezeliteOutput';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';

type OutputDefinitions =
  | typeof DLNA_OUTPUT_DEFINITION
  | typeof SPOTIFY_CONNECT_CONTROLLER_DEFINITION
  | typeof AIRPLAY_OUTPUT_DEFINITION
  | typeof SNAPCAST_OUTPUT_DEFINITION
  | typeof SENDSPIN_OUTPUT_DEFINITION
  | typeof GOOGLE_CAST_OUTPUT_DEFINITION
  | typeof SENDSPIN_CAST_OUTPUT_DEFINITION
  | typeof SNAPCAST_CAST_OUTPUT_DEFINITION
  | typeof SONOS_OUTPUT_DEFINITION
  | typeof SQUEEZELITE_OUTPUT_DEFINITION;

export const OUTPUT_DEFINITIONS: OutputDefinitions[] = [
  DLNA_OUTPUT_DEFINITION,
  SPOTIFY_CONNECT_CONTROLLER_DEFINITION,
  AIRPLAY_OUTPUT_DEFINITION,
  SNAPCAST_OUTPUT_DEFINITION,
  SENDSPIN_OUTPUT_DEFINITION,
  GOOGLE_CAST_OUTPUT_DEFINITION,
  SENDSPIN_CAST_OUTPUT_DEFINITION,
  SNAPCAST_CAST_OUTPUT_DEFINITION,
  SONOS_OUTPUT_DEFINITION,
  SQUEEZELITE_OUTPUT_DEFINITION,
];
const log = createLogger('Output', 'Factory');

export function buildZoneOutputs(
  zone: ZoneConfig,
  ports: OutputPorts,
): ZoneOutput[] {
  const outputs: ZoneOutput[] = [];
  const primaryOutput = getPrimaryOutputConfig(zone);
  const entries = primaryOutput ? [primaryOutput] : [];
  let hasAirplayOutput = false;
  let hasSpotifyController = false;

  for (const entry of entries) {
    const id = entry.id?.toLowerCase();
    if (id === 'dlna') {
      const output = createDlnaOutput(entry, zone, ports);
      if (output) {
        outputs.push(output);
      }
    }
    if (id === 'airplay') {
      const output = createAirplayOutput(zone, ports);
      if (output) {
        outputs.push(output);
        hasAirplayOutput = true;
      }
    }
    if (id === 'snapcast') {
      const output = createSnapcastOutput(entry, zone, ports);
      if (output) {
        outputs.push(output);
      }
    }
    if (id === 'sendspin') {
      const output = createSendspinOutput(entry, zone, ports);
      if (output) {
        outputs.push(output);
      }
    }
    if (id === 'googlecast') {
      const output = createGoogleCastOutput(entry, zone, ports);
      if (output) {
        outputs.push(output);
      }
    }
    if (id === 'sendspin-cast') {
      const output = createSendspinCastOutput(entry, zone, ports);
      if (output) {
        outputs.push(output);
      }
    }
    if (id === 'snapcast-cast') {
      const output = createSnapcastCastOutput(entry, zone, ports);
      if (output) {
        outputs.push(output);
      }
    }
    if (id === 'spotify') {
      const output = createSpotifyController(entry, zone, ports);
      if (output) {
        outputs.push(output);
        hasSpotifyController = true;
      }
    }
    if (id === 'sonos') {
      const output = createSonosOutput(entry, zone, ports);
      if (output) {
        outputs.push(output);
      }
    }
    if (id === 'squeezelite') {
      const output = createSqueezeliteOutput(entry, zone, ports);
      if (output) {
        outputs.push(output);
      }
    }
  }

  // Always create a Spotify Connect controller when the Spotify input is enabled,
  // so Spotify content can be fetched even if no explicit output entry exists.
  if (!hasSpotifyController && isSpotifyInputEnabled(zone)) {
    const output = createSpotifyController(null, zone, ports);
    if (output) {
      outputs.push(output);
      hasSpotifyController = true;
    }
  }

  if (!hasAirplayOutput && isAirplayInputEnabled(zone)) {
    const output = createAirplayOutput(zone, ports);
    if (output) {
      outputs.push(output);
      hasAirplayOutput = true;
    }
  }

  return outputs;
}

function createDlnaOutput(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
  ports: OutputPorts,
): ZoneOutput | null {
  const rawHost = (config as Record<string, unknown>).host;
  const rawControlUrl = (config as Record<string, unknown>).controlUrl;
  const host = typeof rawHost === 'string' ? rawHost.trim() : '';
  const controlUrl = typeof rawControlUrl === 'string' ? rawControlUrl.trim() : '';

  if (!host && !controlUrl) {
    log.warn('DLNA output skipped (missing host and control URL)', { zoneId: zone.id });
    return null;
  }

  log.info('DLNA output registered', {
    zoneId: zone.id,
    host,
    controlUrl: controlUrl || undefined,
  });

  return new DlnaOutput(zone.id, zone.name, { host, controlUrl }, ports);
}

function createSpotifyController(
  config: ZoneTransportConfig | null,
  zone: ZoneConfig,
  ports: OutputPorts,
): ZoneOutput | null {
  if (!isSpotifyInputEnabled(zone)) {
    log.debug('Spotify Connect output skipped; spotify input disabled', {
      zoneId: zone.id,
    });
    return null;
  }
  const spotifyInput = zone.inputs?.spotify;
  const rawDeviceName = (config as Record<string, unknown> | null | undefined)?.name;
  const rawDeviceId = (config as Record<string, unknown> | null | undefined)?.deviceId;
  const deviceName =
    typeof rawDeviceName === 'string' && rawDeviceName.trim()
      ? rawDeviceName.trim()
      : typeof spotifyInput?.publishName === 'string' && spotifyInput.publishName.trim()
        ? spotifyInput.publishName.trim()
        : zone.name;
  const deviceId =
    typeof rawDeviceId === 'string' && rawDeviceId.trim()
      ? rawDeviceId.trim()
      : typeof spotifyInput?.deviceId === 'string' && spotifyInput.deviceId.trim()
        ? spotifyInput.deviceId.trim()
        : undefined;
  const connectEnabled = zone.inputs?.spotify?.offload === true;

  if (connectEnabled) {
    log.info('Spotify Connect output registered', {
      zoneId: zone.id,
      deviceName,
      deviceId: deviceId || 'librespot-auto',
    });

    return new SpotifyConnectInputController(
      zone.id,
      zone.name,
      { deviceName, deviceId },
      ports.config,
      ports.spotifyManagerProvider,
      ports.spotifyDeviceRegistry,
      ports.outputHandlers,
    );
  }

  log.info('Spotify Connect output skipped; offload is false', { zoneId: zone.id });
  return null;
}

function createSqueezeliteOutput(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
  ports: OutputPorts,
): ZoneOutput | null {
  const rawPlayerId = (config as Record<string, unknown>).playerId;
  const rawPlayerName = (config as Record<string, unknown>).playerName;
  const playerId = typeof rawPlayerId === 'string' ? rawPlayerId.trim() : '';
  const playerName = typeof rawPlayerName === 'string' ? rawPlayerName.trim() : '';

  if (!playerId && !playerName) {
    log.warn('Squeezelite output skipped; missing playerId/playerName', { zoneId: zone.id });
    return null;
  }

  const cfg: SqueezeliteOutputConfig = { playerId: playerId || undefined, playerName: playerName || undefined };
  log.info('Squeezelite output registered', { zoneId: zone.id, playerId: cfg.playerId, playerName: cfg.playerName });
  return new SqueezeliteOutput(zone.id, zone.name, cfg, ports);
}

function isSpotifyInputEnabled(zone: ZoneConfig): boolean {
  const cfg = zone.inputs?.spotify;
  return cfg ? cfg.enabled !== false : true;
}

function isAirplayInputEnabled(zone: ZoneConfig): boolean {
  const cfg = zone.inputs?.airplay;
  return cfg ? cfg.enabled !== false : true;
}

function createAirplayOutput(
  zone: ZoneConfig,
  ports: OutputPorts,
): ZoneOutput | null {
  const primaryOutput = getPrimaryOutputConfig(zone);
  const rawEntry =
    primaryOutput && primaryOutput.id?.toLowerCase() === 'airplay' ? primaryOutput : null;
  const inputAirplay = (zone.inputs as any)?.airplay;
  const inputHost = typeof inputAirplay?.host === 'string' ? inputAirplay.host : undefined;
  const host =
    (rawEntry as unknown as AirPlayOutputConfig | undefined)?.host ||
    inputHost;
  const rawPort =
    (rawEntry as unknown as AirPlayOutputConfig | undefined)?.port ||
    (inputHost ? inputAirplay?.port : undefined);
  if (!host || !isAirplayInputEnabled(zone)) {
    log.debug('AirPlay output skipped; airplay input disabled', { zoneId: zone.id });
    return null;
  }
  const name = (rawEntry as any)?.name;
  const password = (rawEntry as any)?.password;
  const debug = (rawEntry as any)?.debug;
  const forceAp2 = (rawEntry as any)?.forceAp2;
  const port = Number(rawPort);
  const initialVolume = clampVolume(zone.volumes?.default);
  return new AirPlayOutput(
    zone.id,
    zone.name,
    {
      host,
      name,
      password,
      port: Number.isFinite(port) ? port : undefined,
      debug: typeof debug === 'boolean' ? debug : undefined,
      forceAp2: typeof forceAp2 === 'boolean' ? forceAp2 : undefined,
    },
    ports,
    initialVolume,
  );
}

function getPrimaryOutputConfig(zone: ZoneConfig): ZoneTransportConfig | null {
  if (zone.output && typeof zone.output === 'object') {
    return zone.output as ZoneTransportConfig;
  }
  if (Array.isArray(zone.transports) && zone.transports.length > 0) {
    return zone.transports[0] ?? null;
  }
  return null;
}

function createSonosOutput(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
  ports: OutputPorts,
): ZoneOutput | null {
  const rawHost = (config as Record<string, unknown>).host;
  const rawControlUrl = (config as Record<string, unknown>).controlUrl;
  const host = typeof rawHost === 'string' ? rawHost.trim() : '';
  const controlUrl = typeof rawControlUrl === 'string' ? rawControlUrl.trim() : '';

  log.info('Sonos output registered', {
    zoneId: zone.id,
    host,
    controlUrl: controlUrl || undefined,
  });

  return new SonosOutput(zone.id, zone.name, {
    host,
    controlUrl,
    networkScan: (config as Record<string, unknown>).networkScan,
    householdId: (config as Record<string, unknown>).householdId as string | undefined,
    deviceName: (config as Record<string, unknown>).deviceName as string | undefined,
  } as SonosOutputConfig, ports);
}

function createSnapcastOutput(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
  ports: OutputPorts,
): ZoneOutput | null {
  const rawClientIds = (config as Record<string, unknown>).clientIds;
  let clientIds: string[] = [];
  if (Array.isArray(rawClientIds)) {
    clientIds = rawClientIds
      .filter((c) => typeof c === 'string' && c.trim())
      .map((c) => c.trim());
  } else if (typeof rawClientIds === 'string' && rawClientIds.trim()) {
    clientIds = rawClientIds
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
  }

  if (clientIds.length === 0) {
    log.warn('Snapcast output skipped; missing clientId mapping', { zoneId: zone.id });
    return null;
  }

  // WebSocket server is shared via HTTP gateway; per-zone output just registers a stream.
  log.info('Snapcast output registered (ws via /snapcast)', { zoneId: zone.id, clientIds });
  const snapConfig: SnapcastOutputConfig = { clientIds };
  return new SnapcastOutput(zone.id, zone.name, snapConfig, ports);
}

function createSendspinOutput(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
  ports: OutputPorts,
): ZoneOutput | null {
  const rawClientId = (config as Record<string, unknown>).clientId;
  const clientId = typeof rawClientId === 'string' ? rawClientId.trim() : '';
  if (!clientId) {
    log.warn('Sendspin output skipped; missing clientId', { zoneId: zone.id });
    return null;
  }
  const sendspinConfig: SendspinOutputConfig = { clientId };
  log.info('Sendspin output registered', { zoneId: zone.id, clientId });
  return new SendspinOutput(zone.id, zone.name, sendspinConfig, undefined, ports);
}

function createGoogleCastOutput(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
  ports: OutputPorts,
): ZoneOutput | null {
  const host = typeof (config as any).host === 'string' ? (config as any).host.trim() : '';
  if (!host) {
    log.warn('Google Cast output skipped; missing host', { zoneId: zone.id });
    return null;
  }
  const name = typeof (config as any).name === 'string' ? (config as any).name : undefined;
  const rawUseSendspin = (config as any).useSendspin;
  const useSendspin =
    rawUseSendspin === true ||
    (typeof rawUseSendspin === 'string' && rawUseSendspin.trim().toLowerCase() === 'true');
  if (useSendspin) {
    const namespace =
      typeof (config as any).sendspinNamespace === 'string'
        ? (config as any).sendspinNamespace
        : undefined;
    const playerId =
      typeof (config as any).sendspinPlayerId === 'string'
        ? (config as any).sendspinPlayerId
        : undefined;
    const syncDelayRaw = (config as any).sendspinSyncDelayMs;
    const syncDelayMs = Number(syncDelayRaw);
    const sendspinCastConfig: SendspinCastOutputConfig = {
      host,
      name,
      namespace,
      playerId,
      syncDelayMs: Number.isFinite(syncDelayMs) ? syncDelayMs : undefined,
    };
    log.info('Sendspin Cast output registered', { zoneId: zone.id, host });
    return new SendspinCastOutput(zone.id, zone.name, sendspinCastConfig, ports);
  }
  const googleCastConfig: GoogleCastOutputConfig = { host, name };
  log.info('Google Cast output registered', { zoneId: zone.id, host });
  return new GoogleCastOutput(zone.id, zone.name, googleCastConfig, ports);
}

function createSendspinCastOutput(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
  ports: OutputPorts,
): ZoneOutput | null {
  const host = typeof (config as any).host === 'string' ? (config as any).host.trim() : '';
  if (!host) {
    log.warn('Sendspin Cast output skipped; missing host', { zoneId: zone.id });
    return null;
  }
  const name = typeof (config as any).name === 'string' ? (config as any).name : undefined;
  const namespace =
    typeof (config as any).namespace === 'string' ? (config as any).namespace : undefined;
  const playerId =
    typeof (config as any).playerId === 'string' ? (config as any).playerId : undefined;
  const syncDelayRaw = (config as any).syncDelayMs;
  const syncDelayMs = Number(syncDelayRaw);
  const sendspinCastConfig: SendspinCastOutputConfig = {
    host,
    name,
    namespace,
    playerId,
    syncDelayMs: Number.isFinite(syncDelayMs) ? syncDelayMs : undefined,
  };
  log.info('Sendspin Cast output registered', { zoneId: zone.id, host });
  return new SendspinCastOutput(zone.id, zone.name, sendspinCastConfig, ports);
}

function createSnapcastCastOutput(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
  ports: OutputPorts,
): ZoneOutput | null {
  const host = typeof (config as any).host === 'string' ? (config as any).host.trim() : '';
  if (!host) {
    log.warn('Snapcast Cast output skipped; missing cast host', { zoneId: zone.id });
    return null;
  }
  const name = typeof (config as any).name === 'string' ? (config as any).name : undefined;
  const streamId =
    typeof (config as any).streamId === 'string' ? (config as any).streamId : undefined;
  const clientId =
    typeof (config as any).clientId === 'string' ? (config as any).clientId : undefined;
  const serverHost =
    typeof (config as any).serverHost === 'string'
      ? (config as any).serverHost
      : ports.config.getSystemConfig()?.audioserver?.ip;
  const snapcastCastConfig: SnapcastCastOutputConfig = {
    host,
    name,
    streamId,
    clientId,
    serverHost,
  };
  log.info('Snapcast Cast output registered', { zoneId: zone.id, host, streamId });
  return new SnapcastCastOutput(zone.id, zone.name, snapcastCastConfig, ports);
}

function clampVolume(value: number | string | undefined): number | undefined {
  const numeric =
    typeof value === 'string'
      ? Number(value.trim())
      : value;
  if (!Number.isFinite(numeric)) return undefined;
  return Math.min(100, Math.max(0, Math.round(numeric as number)));
}
