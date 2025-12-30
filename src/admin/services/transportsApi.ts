import { API_BASE } from '../config/apiConfig';
import type { TransportConfigDefinition } from '@/modules/audio/outputs/types';

type TransportDefinitionsResponse = {
  transports?: TransportConfigDefinition[];
};

export type AirplayDeviceResponse = {
  devices?: AirplayDevice[];
};

export interface AirplayDevice {
  id: string;
  name: string;
  host: string;
  address?: string;
  port: number;
  protocol: 'airplay' | 'raop';
  txt?: Record<string, unknown>;
}

export type GoogleCastDeviceResponse = {
  devices?: GoogleCastDevice[];
};

export interface GoogleCastDevice {
  id: string;
  name: string;
  host: string;
  address?: string;
  port: number;
  manufacturer?: string;
  model?: string;
  txt?: Record<string, unknown>;
}

export type DlnaDeviceResponse = {
  devices?: DlnaDevice[];
};

export interface DlnaDevice {
  id: string;
  name?: string;
  host: string;
  address?: string;
  location?: string;
  controlUrl?: string;
  renderingControlUrl?: string;
}

export type SendspinClientResponse = {
  clients?: SendspinClient[];
};

export interface SendspinClient {
  id: string;
  name: string;
  clientId: string;
  host?: string;
  address?: string;
  port?: number;
  path?: string;
}

export interface SnapcastClient {
  id: string;
  clientId: string;
  streamId?: string;
  connected?: boolean;
  connectedAt?: number;
}

export type SpotifyDeviceResponse = {
  devices?: SpotifyDevice[];
};

export interface SpotifyDevice {
  id: string;
  name: string;
  host?: string;
  address?: string;
  deviceId?: string;
  accountLabel?: string;
  origin?: string;
  type?: string;
  isActive?: boolean;
  supportsVolume?: boolean;
  volumePercent?: number;
}

export type MusicAssistantPlayerResponse = {
  devices?: MusicAssistantPlayer[];
};

export interface MusicAssistantPlayer {
  id: string;
  name?: string;
  deviceId?: string;
}

export async function getTransportDefinitions(): Promise<TransportConfigDefinition[]> {
  const res = await fetch(`${API_BASE}/transports`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to load transports');
  }
  const payload = (await res.json()) as TransportDefinitionsResponse;
  return payload.transports ?? [];
}

export async function discoverAirplayDevices(): Promise<AirplayDevice[]> {
  const res = await fetch(`${API_BASE}/transports/airplay/devices`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to discover AirPlay devices');
  }
  const payload = (await res.json()) as AirplayDeviceResponse;
  return payload.devices ?? [];
}

export async function discoverGoogleCastDevices(host?: string): Promise<GoogleCastDevice[]> {
  const url =
    host && host.trim().length > 0
      ? `${API_BASE}/transports/googlecast/devices?host=${encodeURIComponent(host.trim())}`
      : `${API_BASE}/transports/googlecast/devices`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to discover Google Cast devices');
  }
  const payload = (await res.json()) as GoogleCastDeviceResponse;
  return payload.devices ?? [];
}

export async function discoverDlnaDevices(host?: string): Promise<DlnaDevice[]> {
  const url =
    host && host.trim().length > 0
      ? `${API_BASE}/transports/dlna/devices?host=${encodeURIComponent(host.trim())}`
      : `${API_BASE}/transports/dlna/devices`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to discover DLNA devices');
  }
  const payload = (await res.json()) as DlnaDeviceResponse;
  return payload.devices ?? [];
}

export async function discoverSendspinClients(): Promise<SendspinClient[]> {
  const res = await fetch(`${API_BASE}/transports/sendspin/clients`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to discover Sendspin clients');
  }
  const payload = (await res.json()) as SendspinClientResponse;
  return payload.clients ?? [];
}

export async function discoverSnapcastClients(): Promise<SnapcastClient[]> {
  const res = await fetch(`${API_BASE}/transports/snapcast/clients`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to discover Snapcast clients');
  }
  const payload = (await res.json()) as { clients?: SnapcastClient[] };
  return payload.clients ?? [];
}

export async function discoverSpotifyDevices(): Promise<SpotifyDevice[]> {
  const res = await fetch(`${API_BASE}/transports/spotify/devices`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to discover Spotify devices');
  }
  const payload = (await res.json()) as SpotifyDeviceResponse;
  return payload.devices ?? [];
}

export async function discoverMusicAssistantPlayers(): Promise<MusicAssistantPlayer[]> {
  const res = await fetch(`${API_BASE}/transports/musicassistant/devices`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to discover Music Assistant players');
  }
  const payload = (await res.json()) as MusicAssistantPlayerResponse;
  return payload.devices ?? [];
}

export async function pingTransport(host: string, port?: number): Promise<{ reachable: boolean }> {
  const body = { host, port };
  const res = await fetch(`${API_BASE}/transports/ping`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Ping failed');
  }
  return (await res.json()) as { reachable: boolean };
}
