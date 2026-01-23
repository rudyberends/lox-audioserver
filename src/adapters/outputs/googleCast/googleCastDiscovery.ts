import Bonjour from 'bonjour-service';
import { createLogger } from '@/shared/logging/logger';
import { bestEffort } from '@/shared/bestEffort';

export interface GoogleCastDeviceDescriptor {
  id: string;
  name: string;
  host: string;
  address?: string;
  port: number;
  manufacturer?: string;
  model?: string;
  txt?: Record<string, unknown>;
}

const log = createLogger('Transport', 'GoogleCastDiscovery');

export async function discoverGoogleCastDevices(
  timeoutMs = 8000,
  explicitHosts?: string[],
): Promise<GoogleCastDeviceDescriptor[]> {
  const bonjour = new Bonjour();
  const services = new Map<string, GoogleCastDeviceDescriptor>();
  const browsers: Array<ReturnType<Bonjour['find']>> = [];
  const manualHosts = Array.from(
    new Set(
      (explicitHosts ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
  const effectiveTimeout = manualHosts.length
    ? Math.max(2000, Math.min(timeoutMs, 4000))
    : Math.max(2000, timeoutMs);

  const finish = (): GoogleCastDeviceDescriptor[] => {
    browsers.forEach((browser) => {
      try {
        browser.stop();
      } catch {
        /* noop */
      }
    });
    try {
      bonjour.destroy();
    } catch {
      /* noop */
    }
    const devices = Array.from(services.values());
    devices.sort((a, b) => a.name.localeCompare(b.name));
    return devices;
  };

  const normalizeHost = (value: string | undefined): string | undefined =>
    value ? value.replace(/\.$/, '') : undefined;

  const normalizeKey = (value: string | undefined): string =>
    (value || '').trim().toLowerCase();

  const storeService = (key: string, descriptor: GoogleCastDeviceDescriptor): void => {
    if (!key) {
      services.set(descriptor.id, descriptor);
      return;
    }
    const existing = services.get(key);
    if (!existing) {
      services.set(key, descriptor);
      return;
    }
    if (!existing.address && descriptor.address) {
      services.set(key, descriptor);
    }
  };

  const probeEurekaInfo = async (
    host: string,
    port: number,
    timeout = 1500,
  ): Promise<any | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(`http://${host}:${port}/setup/eureka_info?options=detail`, {
        signal: controller.signal,
      });
      if (!res.ok) return null;
      return await bestEffort(() => res.json() as Promise<any>, {
        fallback: null,
        onError: 'debug',
        log,
        label: 'google cast eureka info read failed',
        context: { host, status: res.status },
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const probeExplicitHost = async (host: string): Promise<GoogleCastDeviceDescriptor | null> => {
    // Try the common unauthenticated setup endpoint first.
    const info = (await probeEurekaInfo(host, 8008)) || (await probeEurekaInfo(host, 8443));
    if (!info) return null;
    const name =
      info.name ||
      info.device_name ||
      info.ssid ||
      info.friendlyName ||
      info.friendlyname ||
      host;
    const manufacturer = info.manufacturer || info.manufacturer_name;
    const model = info.model_name || info.model;
    const port = typeof info.port === 'number' && info.port > 0 ? info.port : 8009;
    const idBase =
      typeof info.ssdp_udn === 'string' && info.ssdp_udn ? info.ssdp_udn : `${host}-${name}`;
    const descriptor: GoogleCastDeviceDescriptor = {
      id: `${idBase}-${port}`,
      name,
      host,
      address: info.ip_address || info.ip || host,
      port,
      manufacturer,
      model,
      txt: {
        ...info,
        source: 'manual-probe',
      },
    };
    log.debug('google cast manual probe success', { host, descriptor });
    return descriptor;
  };

  const probeExplicitHosts = async (): Promise<void> => {
    if (!manualHosts.length) return;
    for (const host of manualHosts) {
      try {
        const descriptor = await probeExplicitHost(host);
        if (descriptor) {
          const key = normalizeKey(descriptor.address || descriptor.host || descriptor.name);
          storeService(key, descriptor);
        } else {
          log.debug('google cast manual probe empty', { host });
        }
      } catch (err) {
        log.debug('google cast manual probe failed', { host, message: (err as Error)?.message });
      }
    }
  };

  return new Promise<GoogleCastDeviceDescriptor[]>((resolve) => {
    const manualProbePromise = probeExplicitHosts();

    const timer = setTimeout(async () => {
      // Best-effort await; discovery should still finish if manual probes fail.
      await bestEffort(() => manualProbePromise, {
        fallback: undefined,
        onError: 'debug',
        log,
        label: 'google cast manual probe failed',
      });
      resolve(finish());
    }, effectiveTimeout);

    const handle = (service: any): void => {
      const addresses: string[] = Array.isArray(service.addresses)
        ? (service.addresses as string[])
        : [];
      const referer = service.referer as { address?: string } | undefined;
      const address =
        addresses.find((addr) => addr && addr.includes('.')) ??
        addresses[0] ??
        referer?.address;
      const txt = service.txt as Record<string, unknown> | undefined;
      const port =
        typeof service.port === 'number' && service.port > 0 ? service.port : 8009;
      const host =
        normalizeHost(service.host) ||
        normalizeHost(service.fqdn) ||
        normalizeHost(service.name) ||
        address;
      const name =
        (txt?.fn as string) ||
        service.name ||
        service.host ||
        address ||
        `Google Cast ${services.size + 1}`;
      const txtId = typeof txt?.id === 'string' ? txt.id : undefined;
      const id = `${txtId || host || name}-${port}`;
      const key = normalizeKey(address || host || name);
      log.debug('google cast service seen', {
        id,
        host,
        address,
        port,
        name,
        txt,
        rawAddresses: addresses,
      });
      storeService(key, {
        id,
        name,
        host: host || name || 'googlecast',
        address,
        port,
        manufacturer: (txt?.md as string) || undefined,
        model: (txt?.rm as string) || undefined,
        txt,
      });
    };

    try {
      ['googlecast', 'googlezone'].forEach((type) => {
        const browser = bonjour.find({ type, protocol: 'tcp' }, handle);
        browsers.push(browser);
        browser.start();
      });
    } catch (err) {
      log.warn('google cast discovery failed to start', { err });
      clearTimeout(timer);
      resolve(finish());
      return;
    }
  });
}
