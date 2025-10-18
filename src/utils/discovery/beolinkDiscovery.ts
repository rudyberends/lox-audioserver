import Bonjour, { Service, Browser } from 'bonjour-service';
import logger from '../../utils/troxorlogger';

const SERVICE_TYPE = 'beocore';
const SERVICE_PROTOCOL = 'tcp';
const DEFAULT_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 30_000;
const FALLBACK_NODE = 'beocore';

const bonjour = new Bonjour();

export interface BeolinkDevice {
  id: string;
  name: string;
  host: string;
  address: string;
  port: number;
  txt: Record<string, string>;
  lastSeen: number;
}

let cachedDevices = new Map<string, BeolinkDevice>();
let lastDiscovery = 0;
let pendingDiscovery: Promise<BeolinkDevice[]> | null = null;

function normalizeService(service: Service): BeolinkDevice | null {
  if (!service) return null;
  const now = Date.now();
  const txt: Record<string, string> = {};
  if (service.txt && typeof service.txt === 'object') {
    Object.entries(service.txt).forEach(([key, value]) => {
      if (typeof value === 'string' && value.trim()) {
        txt[key] = value.trim();
      }
    });
  }
  const jid = typeof txt.jid === 'string' && txt.jid ? txt.jid : '';
  const fqdn = typeof service.fqdn === 'string' && service.fqdn ? service.fqdn : '';
  const host = typeof service.host === 'string' && service.host ? service.host.replace(/\.$/, '') : fqdn.replace(/\.$/, '');
  const baseId = jid || fqdn || host || service.name || '';
  const port = Number.isFinite(service.port) ? service.port : 0;
  const addresses = Array.isArray(service.addresses) ? service.addresses : [];
  const ipv4 = addresses.find((address) => typeof address === 'string' && /^[0-9.]+$/.test(address));
  const ipv6 = addresses.find((address) => typeof address === 'string' && address.includes(':'));
  const refererAddress = typeof (service as any)?.referer?.address === 'string'
    ? (service as any).referer.address
    : '';
  const address = ipv4 || ipv6 || refererAddress || host;

  if (!baseId || !address) return null;

  const displayName = typeof txt.name === 'string' && txt.name
    ? txt.name
    : service.name || host || baseId;

  return {
    id: `${baseId}:${port || service.type || 'default'}`,
    name: displayName,
    host: host || address,
    address,
    port,
    txt,
    lastSeen: now,
  };
}

function getCachedDevices(): BeolinkDevice[] {
  const now = Date.now();
  cachedDevices = new Map(
    Array.from(cachedDevices.values())
      .filter((device) => now - device.lastSeen <= CACHE_TTL_MS * 2)
      .map((device) => [device.id, device]),
  );
  return Array.from(cachedDevices.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function discoverBeolinkDevices(force = false, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<BeolinkDevice[]> {
  const now = Date.now();
  if (!force && pendingDiscovery) {
    return pendingDiscovery;
  }

  if (!force && now - lastDiscovery < CACHE_TTL_MS && cachedDevices.size) {
    return getCachedDevices();
  }

  pendingDiscovery = new Promise<BeolinkDevice[]>((resolve) => {
    const results = new Map<string, BeolinkDevice>();
    let settled = false;
    const browsers: Browser[] = [];

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browsers.forEach((browser) => {
        try {
          browser.stop();
        } catch {
          // Ignore stop errors so discovery can continue resolving.
        }
      });
      lastDiscovery = Date.now();
      pendingDiscovery = null;
      results.forEach((device) => {
        cachedDevices.set(device.id, device);
      });
      resolve(getCachedDevices());
    };

    const handleService = (service: Service) => {
      const device = normalizeService(service);
      if (!device) return;
      results.set(device.id, device);
    };

    const targetedBrowser: Browser = bonjour.find({ type: SERVICE_TYPE, protocol: SERVICE_PROTOCOL }, handleService);
    browsers.push(targetedBrowser);

    targetedBrowser.on('up', (service: Service) => {
      handleService(service);
    });

    targetedBrowser.on('error', (error: unknown) => {
      logger.warn(`[BeolinkDiscovery] Browser error: ${error instanceof Error ? error.message : String(error)}`);
    });

    const wildcardBrowser: Browser = bonjour.find(null, (service: Service) => {
      const typeMatch = typeof service.type === 'string' && service.type.toLowerCase() === SERVICE_TYPE;
      const nodeMatch = typeof service.txt?.node === 'string' && service.txt.node.toLowerCase() === FALLBACK_NODE;
      if (!typeMatch && !nodeMatch) return;
      handleService(service);
    });
    browsers.push(wildcardBrowser);

    wildcardBrowser.on('up', (service: Service) => {
      const typeMatch = typeof service.type === 'string' && service.type.toLowerCase() === SERVICE_TYPE;
      const nodeMatch = typeof service.txt?.node === 'string' && service.txt.node.toLowerCase() === FALLBACK_NODE;
      if (!typeMatch && !nodeMatch) return;
      handleService(service);
    });

    wildcardBrowser.on('error', (error: unknown) => {
      logger.debug(`[BeolinkDiscovery] Wildcard browser error: ${error instanceof Error ? error.message : String(error)}`);
    });

    browsers.forEach((browser) => {
      if (typeof browser.update === 'function') {
        try {
          browser.update();
        } catch (error) {
          logger.debug(`[BeolinkDiscovery] Failed to send mDNS query: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });

    const timer = setTimeout(() => {
      logger.debug('[BeolinkDiscovery] Discovery window timed out');
      finish();
    }, Math.max(1_500, timeoutMs));
  });

  try {
    return await pendingDiscovery;
  } catch (error) {
    pendingDiscovery = null;
    logger.warn(`[BeolinkDiscovery] Discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    return getCachedDevices();
  }
}

export function getBeolinkDevicesFromCache(): BeolinkDevice[] {
  return getCachedDevices();
}
