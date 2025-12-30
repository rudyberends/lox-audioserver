import { API_BASE } from '../config/apiConfig';
import type { ZoneInputConfig, ZoneTransportConfig } from '@/domain/config/types';

export type ZoneUpdatePayload = {
  id: number;
  inputs?: ZoneInputConfig;
  transports?: ZoneTransportConfig[];
};

export type ZonePlaybackState = {
  id: number;
  name: string;
  title?: string;
  artist?: string;
  album?: string;
  sourceName?: string;
  station?: string;
  state?: string;
  updatedAt?: string | number | null;
  tech?: {
    input?: {
      kind?: string | null;
      format?: string | null;
      sampleRate?: number | null;
      channels?: number | null;
    } | null;
    output?: {
      profiles?: string[];
      sampleRate?: number;
      channels?: number;
      bitrate?: string;
      pcmBitDepth?: number;
      resampler?: string;
      resamplePrecision?: number;
      resampleCutoff?: number;
      httpProfile?: string;
      httpIcyEnabled?: boolean;
      httpIcyInterval?: number;
      httpIcyName?: string;
      prebufferBytes?: number;
      httpFallbackSeconds?: number;
    };
    inputProvider?: string | null;
    outputTarget?: string | null;
    outputs?: string[];
    transports?: string[];
    session?: {
      state?: string;
      elapsed?: number;
      duration?: number;
      startedAt?: number;
      updatedAt?: number;
    };
    streams?: {
      mp3?: string | null;
      pcm?: string | null;
    };
    streamStats?: Array<{
      profile: string;
      bps?: number | null;
      bufferedBytes?: number;
      totalBytes?: number;
      lastUpdated?: number | null;
      subscribers?: number;
      restarts?: number;
      lastError?: string | null;
      lastErrorAt?: number | null;
      lastStderr?: string | null;
      lastStderrAt?: number | null;
      lastExitCode?: number | null;
      lastExitSignal?: string | null;
      lastExitAt?: number | null;
      subscriberDrops?: number;
      lastSubscriberDropAt?: number | null;
    }>;
    backpressure?: {
      drops: number;
      lastBytes: number;
      lastDropTs: number | null;
      recentDrops: number;
    } | null;
    sendspin?: {
      codec: string;
      sampleRate: number;
      channels: number;
      bitDepth: number;
      bufferCapacity?: number | null;
      leadUs?: number | null;
      targetLeadUs?: number | null;
      bufferedBytes?: number | null;
      leadUpdatedAt?: number | null;
      protocol?: string | null;
    };
  };
};

export type ZoneStatesResponse = {
  zones?: ZonePlaybackState[];
  system?: {
    now?: number;
    loadavg?: number[];
    uptimeSec?: number;
    clockOffsetMs?: number;
    cores?: number;
  };
};

export async function updateZones(zones: ZoneUpdatePayload[]): Promise<void> {
  const res = await fetch(`${API_BASE}/config/zones`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ zones }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to update zones');
  }
}

async function postZoneMaintenance(path: string, errorMessage: string): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || errorMessage);
  }
}

export async function purgeFavorites(): Promise<void> {
  await postZoneMaintenance('/zones/favorites/purge', 'Failed to purge favorites');
}

export async function purgeRecents(): Promise<void> {
  await postZoneMaintenance('/zones/recents/purge', 'Failed to purge recently played items');
}

export async function purgeZoneFavorites(zoneId: number): Promise<void> {
  await postZoneMaintenance(`/zones/${zoneId}/favorites/purge`, 'Failed to purge favorites for this zone');
}

export async function purgeZoneRecents(zoneId: number): Promise<void> {
  await postZoneMaintenance(`/zones/${zoneId}/recents/purge`, 'Failed to purge recently played items for this zone');
}

export async function copyZoneFavorites(sourceZoneId: number, destinationZoneIds: number[]): Promise<void> {
  const res = await fetch(`${API_BASE}/zones/${sourceZoneId}/favorites/copy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destinations: destinationZoneIds }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to copy favorites');
  }
}

export async function fetchZoneStates(): Promise<{ map: Record<number, ZonePlaybackState>; system?: ZoneStatesResponse['system'] }> {
  const res = await fetch(`${API_BASE}/zones/states`);
  if (!res.ok) {
    throw new Error('Failed to fetch zone states');
  }
  const payload = (await res.json()) as ZoneStatesResponse | ZonePlaybackState[];
  const list = Array.isArray((payload as any).zones)
    ? (payload as any).zones
    : Array.isArray(payload)
      ? payload
      : [];
  const map: Record<number, ZonePlaybackState> = {};
  list.forEach((entry: ZonePlaybackState) => {
    if (entry && typeof entry.id === 'number') {
      map[entry.id] = entry;
    }
  });
  return { map, system: (payload as any).system };
}
