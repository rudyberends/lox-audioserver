import { createLogger } from '@/core/logging/logger';
import type { ZoneConfig, ZoneTransportConfig } from '@/domain/config/types';
import type { ZoneTransport } from '@/modules/audio/outputs/types';
import {
  DlnaTransport,
  DLNA_TRANSPORT_DEFINITION,
} from '@/modules/audio/outputs/dlna/dlnaTransport';
import {
  SpotifyConnectInputController,
  SPOTIFY_CONNECT_CONTROLLER_DEFINITION,
} from '@/modules/audio/inputs/spotify/spotifyConnectController';
import {
  AirPlayTransport,
  AIRPLAY_TRANSPORT_DEFINITION,
  type AirPlayTransportConfig,
} from '@/modules/audio/outputs/airplay/airplayTransport';
import {
  SnapcastTransport,
  SNAPCAST_TRANSPORT_DEFINITION,
  type SnapcastTransportConfig,
} from '@/modules/audio/outputs/snapcast/snapcastTransport';
import {
  SendspinTransport,
  SENDSPIN_TRANSPORT_DEFINITION,
  type SendspinTransportConfig,
} from '@/modules/audio/outputs/sendspin/sendspinTransport';
import {
  GoogleCastTransport,
  GOOGLE_CAST_TRANSPORT_DEFINITION,
  type GoogleCastTransportConfig,
} from '@/modules/audio/outputs/googleCast/googleCastTransport';
import {
  SendspinCastTransport,
  SENDSPIN_CAST_TRANSPORT_DEFINITION,
  type SendspinCastTransportConfig,
} from '@/modules/audio/outputs/googleCast/sendspinCastTransport';
import {
  SnapcastCastTransport,
  SNAPCAST_CAST_TRANSPORT_DEFINITION,
  type SnapcastCastTransportConfig,
} from '@/modules/audio/outputs/googleCast/snapcastCastTransport';
import { getSystemConfig } from '@/domain/config/configStore';

type TransportDefinitions =
  | typeof DLNA_TRANSPORT_DEFINITION
  | typeof SPOTIFY_CONNECT_CONTROLLER_DEFINITION
  | typeof AIRPLAY_TRANSPORT_DEFINITION
  | typeof SNAPCAST_TRANSPORT_DEFINITION
  | typeof SENDSPIN_TRANSPORT_DEFINITION
  | typeof GOOGLE_CAST_TRANSPORT_DEFINITION
  | typeof SENDSPIN_CAST_TRANSPORT_DEFINITION
  | typeof SNAPCAST_CAST_TRANSPORT_DEFINITION;

export const TRANSPORT_DEFINITIONS: TransportDefinitions[] = [
  DLNA_TRANSPORT_DEFINITION,
  SPOTIFY_CONNECT_CONTROLLER_DEFINITION,
  AIRPLAY_TRANSPORT_DEFINITION,
  SNAPCAST_TRANSPORT_DEFINITION,
  SENDSPIN_TRANSPORT_DEFINITION,
  GOOGLE_CAST_TRANSPORT_DEFINITION,
  SENDSPIN_CAST_TRANSPORT_DEFINITION,
  SNAPCAST_CAST_TRANSPORT_DEFINITION,
];
const log = createLogger('Transport', 'Factory');

export function buildZoneTransports(zone: ZoneConfig): ZoneTransport[] {
  const transports: ZoneTransport[] = [];
  const entries = zone.transports ?? [];
  let hasAirplayTransport = false;
  let hasSpotifyController = false;

  for (const entry of entries) {
    const id = entry.id?.toLowerCase();
    if (id === 'dlna') {
      const transport = createDlnaTransport(entry, zone);
      if (transport) {
        transports.push(transport);
      }
    }
    if (id === 'airplay') {
      const transport = createAirplayTransport(zone);
      if (transport) {
        transports.push(transport);
        hasAirplayTransport = true;
      }
    }
    if (id === 'snapcast') {
      const transport = createSnapcastTransport(entry, zone);
      if (transport) {
        transports.push(transport);
      }
    }
    if (id === 'sendspin') {
      const transport = createSendspinTransport(entry, zone);
      if (transport) {
        transports.push(transport);
      }
    }
    if (id === 'googlecast') {
      const transport = createGoogleCastTransport(entry, zone);
      if (transport) {
        transports.push(transport);
      }
    }
    if (id === 'sendspin-cast') {
      const transport = createSendspinCastTransport(entry, zone);
      if (transport) {
        transports.push(transport);
      }
    }
    if (id === 'snapcast-cast') {
      const transport = createSnapcastCastTransport(entry, zone);
      if (transport) {
        transports.push(transport);
      }
    }
    if (id === 'spotify') {
      const transport = createSpotifyController(entry, zone);
      if (transport) {
        transports.push(transport);
        hasSpotifyController = true;
      }
    }
  }

  // Always create a Spotify Connect controller when the Spotify input is enabled,
  // so Spotify content can be fetched even if no explicit transport entry exists.
  if (!hasSpotifyController && isSpotifyInputEnabled(zone)) {
    const transport = createSpotifyController(null, zone);
    if (transport) {
      transports.push(transport);
      hasSpotifyController = true;
    }
  }

  if (!hasAirplayTransport && isAirplayInputEnabled(zone)) {
    const transport = createAirplayTransport(zone);
    if (transport) {
      transports.push(transport);
      hasAirplayTransport = true;
    }
  }

  return transports;
}

function createDlnaTransport(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
): ZoneTransport | null {
  const rawHost = (config as Record<string, unknown>).host;
  const rawControlUrl = (config as Record<string, unknown>).controlUrl;
  const host = typeof rawHost === 'string' ? rawHost.trim() : '';
  const controlUrl = typeof rawControlUrl === 'string' ? rawControlUrl.trim() : '';

  if (!host && !controlUrl) {
    log.warn('DLNA transport skipped (missing host and control URL)', { zoneId: zone.id });
    return null;
  }

  log.info('DLNA transport registered', {
    zoneId: zone.id,
    host,
    controlUrl: controlUrl || undefined,
  });

  return new DlnaTransport(zone.id, zone.name, { host, controlUrl });
}

function createSpotifyController(
  config: ZoneTransportConfig | null,
  zone: ZoneConfig,
): ZoneTransport | null {
  if (!isSpotifyInputEnabled(zone)) {
    log.debug('Spotify Connect transport skipped; spotify input disabled', {
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
    log.info('Spotify Connect transport registered', {
      zoneId: zone.id,
      deviceName,
      deviceId: deviceId || 'librespot-auto',
    });

    return new SpotifyConnectInputController(zone.id, zone.name, { deviceName, deviceId });
  }

  log.info('Spotify Connect transport skipped; offload is false', { zoneId: zone.id });
  return null;
}

function isSpotifyInputEnabled(zone: ZoneConfig): boolean {
  const cfg = zone.inputs?.spotify;
  return cfg ? cfg.enabled !== false : true;
}

function isAirplayInputEnabled(zone: ZoneConfig): boolean {
  const cfg = zone.inputs?.airplay;
  return cfg ? cfg.enabled !== false : true;
}

function createAirplayTransport(zone: ZoneConfig): ZoneTransport | null {
  const rawEntry = (zone.transports ?? []).find((t) => t.id?.toLowerCase() === 'airplay');
  const host =
    (rawEntry as unknown as AirPlayTransportConfig | undefined)?.host ||
    (zone.inputs as any)?.airplay?.host;
  const rawPort =
    (rawEntry as unknown as AirPlayTransportConfig | undefined)?.port ||
    (zone.inputs as any)?.airplay?.port;
  if (!host || !isAirplayInputEnabled(zone)) {
    log.debug('AirPlay transport skipped; airplay input disabled', { zoneId: zone.id });
    return null;
  }
  const name = (rawEntry as any)?.name;
  const password = (rawEntry as any)?.password;
  const port = Number(rawPort);
  const initialVolume = clampVolume(zone.volumes?.default);
  return new AirPlayTransport(
    zone.id,
    zone.name,
    {
      host,
      name,
      password,
      port: Number.isFinite(port) ? port : undefined,
    },
    initialVolume,
  );
}

function createSnapcastTransport(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
): ZoneTransport | null {
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
    log.warn('Snapcast transport skipped; missing clientId mapping', { zoneId: zone.id });
    return null;
  }

  // WebSocket server is shared via HTTP gateway; per-zone transport just registers a stream.
  log.info('Snapcast transport registered (ws via /snapcast)', { zoneId: zone.id, clientIds });
  const snapConfig: SnapcastTransportConfig = { clientIds };
  return new SnapcastTransport(zone.id, zone.name, snapConfig);
}

function createSendspinTransport(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
): ZoneTransport | null {
  const rawClientId = (config as Record<string, unknown>).clientId;
  const clientId = typeof rawClientId === 'string' ? rawClientId.trim() : '';
  if (!clientId) {
    log.warn('Sendspin transport skipped; missing clientId', { zoneId: zone.id });
    return null;
  }
  const sendspinConfig: SendspinTransportConfig = { clientId };
  log.info('Sendspin transport registered', { zoneId: zone.id, clientId });
  return new SendspinTransport(zone.id, zone.name, sendspinConfig);
}

function createGoogleCastTransport(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
): ZoneTransport | null {
  const host = typeof (config as any).host === 'string' ? (config as any).host.trim() : '';
  if (!host) {
    log.warn('Google Cast transport skipped; missing host', { zoneId: zone.id });
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
    const sendspinCastConfig: SendspinCastTransportConfig = {
      host,
      name,
      namespace,
      playerId,
      syncDelayMs: Number.isFinite(syncDelayMs) ? syncDelayMs : undefined,
    };
    log.info('Sendspin Cast transport registered', { zoneId: zone.id, host });
    return new SendspinCastTransport(zone.id, zone.name, sendspinCastConfig);
  }
  const googleCastConfig: GoogleCastTransportConfig = { host, name };
  log.info('Google Cast transport registered', { zoneId: zone.id, host });
  return new GoogleCastTransport(zone.id, zone.name, googleCastConfig);
}

function createSendspinCastTransport(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
): ZoneTransport | null {
  const host = typeof (config as any).host === 'string' ? (config as any).host.trim() : '';
  if (!host) {
    log.warn('Sendspin Cast transport skipped; missing host', { zoneId: zone.id });
    return null;
  }
  const name = typeof (config as any).name === 'string' ? (config as any).name : undefined;
  const namespace =
    typeof (config as any).namespace === 'string' ? (config as any).namespace : undefined;
  const playerId =
    typeof (config as any).playerId === 'string' ? (config as any).playerId : undefined;
  const syncDelayRaw = (config as any).syncDelayMs;
  const syncDelayMs = Number(syncDelayRaw);
  const sendspinCastConfig: SendspinCastTransportConfig = {
    host,
    name,
    namespace,
    playerId,
    syncDelayMs: Number.isFinite(syncDelayMs) ? syncDelayMs : undefined,
  };
  log.info('Sendspin Cast transport registered', { zoneId: zone.id, host });
  return new SendspinCastTransport(zone.id, zone.name, sendspinCastConfig);
}

function createSnapcastCastTransport(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
): ZoneTransport | null {
  const host = typeof (config as any).host === 'string' ? (config as any).host.trim() : '';
  if (!host) {
    log.warn('Snapcast Cast transport skipped; missing cast host', { zoneId: zone.id });
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
      : getSystemConfig()?.audioserver?.ip;
  const snapcastCastConfig: SnapcastCastTransportConfig = {
    host,
    name,
    streamId,
    clientId,
    serverHost,
  };
  log.info('Snapcast Cast transport registered', { zoneId: zone.id, host, streamId });
  return new SnapcastCastTransport(zone.id, zone.name, snapcastCastConfig);
}

function clampVolume(value: number | string | undefined): number | undefined {
  const numeric =
    typeof value === 'string'
      ? Number(value.trim())
      : value;
  if (!Number.isFinite(numeric)) return undefined;
  return Math.min(100, Math.max(0, Math.round(numeric as number)));
}
