import Bonjour from 'bonjour-service';
import { createLogger } from '@/shared/logging/logger';

export interface AirplayDeviceDescriptor {
  id: string;
  name: string;
  host: string;
  address?: string;
  port: number;
  protocol: 'airplay' | 'raop';
  txt?: Record<string, unknown>;
}

const log = createLogger('Transport', 'AirPlayDiscovery');

export async function discoverAirplayDevices(timeoutMs = 5000): Promise<AirplayDeviceDescriptor[]> {
  const bonjour = new Bonjour();
  const services = new Map<string, AirplayDeviceDescriptor>();
  const browsers: Array<ReturnType<Bonjour['find']>> = [];

  const close = (): void => {
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
  };

  return new Promise<AirplayDeviceDescriptor[]>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      close();
      const entries = Array.from(services.values());
      entries.sort((a, b) => a.name.localeCompare(b.name));
      resolve(entries);
    };

    const handleService = (service: any, protocol: 'airplay' | 'raop'): void => {
      const txt = service.txt as Record<string, unknown> | undefined;
      const model = typeof txt?.model === 'string' ? txt.model.toLowerCase() : '';
      if (model === 'loxaudioairplay') {
        return;
      }
      const addresses = Array.isArray(service.addresses)
        ? (service.addresses as string[])
        : [];
      const ipv4 = addresses.find((addr) => addr && addr.includes('.')) ?? addresses[0];
      const hostFromName = typeof service.host === 'string' && service.host ? service.host : service.name;
      const host = hostFromName || ipv4 || service.fqdn || '';
      const port = typeof service.port === 'number' && service.port > 0 ? service.port : protocol === 'airplay' ? 7000 : 5000;
      const key = (ipv4 || host || service.name || '').toLowerCase();
      const descriptor: AirplayDeviceDescriptor = {
        id: `${protocol}-${host ?? 'unknown'}-${port}`,
        name: service.name || host || `AirPlay (${protocol})`,
        host: host || 'unknown',
        address: ipv4,
        port,
        protocol,
        txt,
      };
      const existing = key ? services.get(key) : undefined;
      if (!existing) {
        if (key) {
          services.set(key, descriptor);
        } else {
          services.set(descriptor.id, descriptor);
        }
        return;
      }
      if (existing.protocol === 'raop' && descriptor.protocol === 'airplay') {
        services.set(key, descriptor);
      }
    };

    try {
      browsers.push(
        bonjour.find({ type: 'airplay', protocol: 'tcp' }, (service) =>
          handleService(service, 'airplay'),
        ),
      );
      browsers.push(
        bonjour.find({ type: 'raop', protocol: 'tcp' }, (service) =>
          handleService(service, 'raop'),
        ),
      );
      browsers.forEach((browser) => browser.start());
    } catch (err) {
      log.warn('airplay discovery failed to start', { err });
      finish();
      return;
    }

    const timer = setTimeout(finish, Math.max(2000, timeoutMs));
  });
}
