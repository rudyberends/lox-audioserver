import Bonjour from 'bonjour-service';
import { createLogger } from '@/shared/logging/logger';
import type { SpotifyServiceManagerProvider } from '@/adapters/content/providers/spotifyServiceManager';

export interface SpotifyConnectDeviceDescriptor {
  id: string;
  name: string;
  host?: string;
  address?: string;
  port?: number;
  deviceId?: string;
  txt?: Record<string, unknown>;
  accountLabel?: string;
  accountId?: string;
  providerId?: string;
  type?: string;
  origin?: 'spotify-api' | 'mdns';
  isActive?: boolean;
  volumePercent?: number;
  supportsVolume?: boolean;
}

const log = createLogger('Transport', 'SpotifyDiscovery');

export async function discoverSpotifyConnectDevices(
  spotifyManagers: SpotifyServiceManagerProvider,
  timeoutMs = 4500,
): Promise<SpotifyConnectDeviceDescriptor[]> {
  const [bonjourDevices, apiDevices] = await Promise.all([
    discoverBonjourDevices(timeoutMs),
    listSpotifyAccountDevices(spotifyManagers),
  ]);
  if (apiDevices.length === 0) {
    // Fallback to Bonjour entries only when they expose a usable device id (e.g. librespot).
    return bonjourDevices
      .filter((device) => !!device.deviceId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return mergeDevices(apiDevices, bonjourDevices);
}

async function discoverBonjourDevices(timeoutMs: number): Promise<SpotifyConnectDeviceDescriptor[]> {
  const bonjour = new Bonjour();
  const services = new Map<string, SpotifyConnectDeviceDescriptor>();
  let browser: ReturnType<Bonjour['find']> | null = null;

  const finish = (): SpotifyConnectDeviceDescriptor[] => {
    if (browser) {
      try {
        browser.stop();
      } catch {
        /* noop */
      }
    }
    try {
      bonjour.destroy();
    } catch {
      /* noop */
    }
    const entries = Array.from(services.values());
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  };

  return new Promise<SpotifyConnectDeviceDescriptor[]>((resolve) => {
    const timer = setTimeout(() => resolve(finish()), Math.max(2000, timeoutMs));

    const handle = (service: any): void => {
      const addresses: string[] = Array.isArray(service.addresses)
        ? (service.addresses as string[])
        : [];
      const address = addresses.find((addr) => addr && addr.includes('.')) ?? addresses[0];
      const txt = (service.txt ?? {}) as Record<string, unknown>;
      const deviceId =
        readTxtField(txt, 'deviceid') || readTxtField(txt, 'device_id') || undefined;
      const name =
        readTxtField(txt, 'md') ||
        service.name ||
        service.host ||
        deviceId ||
        `Spotify device`;
      const id = `${name}-${deviceId ?? address ?? Math.random()}`;
      services.set(id, {
        id,
        name,
        host: service.host,
        address,
        port: service.port,
        deviceId,
        txt: { ...txt, source: 'mdns' },
        origin: 'mdns',
      });
    };

    try {
      browser = bonjour.find({ type: 'spotify-connect', protocol: 'tcp' }, handle);
      browser.start();
    } catch (err) {
      log.warn('spotify connect discovery failed to start', { err });
      clearTimeout(timer);
      resolve(finish());
    }
  });
}

function readTxtField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

async function listSpotifyAccountDevices(
  spotifyManagers: SpotifyServiceManagerProvider,
): Promise<SpotifyConnectDeviceDescriptor[]> {
  try {
    const manager = spotifyManagers.get();
    const devices = await manager.listConnectDevices();
    return devices.map((device) => ({
      id: device.id,
      name: device.name,
      deviceId: device.id,
      accountId: device.accountId,
      accountLabel: device.accountLabel,
      providerId: device.providerId,
      type: device.type,
      origin: 'spotify-api',
      isActive: device.isActive,
      supportsVolume: device.supportsVolume,
      volumePercent: device.volumePercent,
      txt: {
        accountId: device.accountId,
        accountLabel: device.accountLabel,
        providerId: device.providerId,
        type: device.type,
        source: 'spotify-api',
        isActive: device.isActive,
        supportsVolume: device.supportsVolume,
        volumePercent: device.volumePercent,
      },
    }));
  } catch (err) {
    log.warn('spotify connect api device listing failed', { err });
    return [];
  }
}

function mergeDevices(
  apiDevices: SpotifyConnectDeviceDescriptor[],
  bonjourDevices: SpotifyConnectDeviceDescriptor[],
): SpotifyConnectDeviceDescriptor[] {
  const merged = new Map<string, SpotifyConnectDeviceDescriptor>();
  const nameIndex = new Map<string, string>();
  apiDevices.forEach((device) => {
    merged.set(device.id, { ...device });
    const key = normalizeName(device.name);
    if (key) {
      nameIndex.set(key, device.id);
    }
  });

  bonjourDevices.forEach((device) => {
    const key = normalizeName(device.name);
    if (!key) {
      if (device.deviceId && !merged.has(device.deviceId)) {
        merged.set(device.deviceId, { ...device });
      }
      return;
    }
    const matchId = nameIndex.get(key);
    if (matchId && merged.has(matchId)) {
      const existing = merged.get(matchId)!;
      merged.set(matchId, {
        ...existing,
        host: existing.host ?? device.host,
        address: existing.address ?? device.address,
        port: existing.port ?? device.port,
      });
      return;
    }
    if (device.deviceId) {
      merged.set(device.deviceId, { ...device });
    }
  });

  return Array.from(merged.values())
    .filter((device) => !!device.deviceId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeName(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length ? trimmed : null;
}
