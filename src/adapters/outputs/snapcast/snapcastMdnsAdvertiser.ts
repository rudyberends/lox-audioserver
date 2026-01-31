import net from 'node:net';
import os from 'node:os';
import { createLogger } from '@/shared/logging/logger';
import type { MdnsPort, MdnsRegistration } from '@/ports/MdnsPort';

type SnapcastAdvertiseOptions = {
  name: string;
  host?: string;
  streamPort: number;
  httpPort: number;
};

export class SnapcastMdnsAdvertiser {
  private readonly log = createLogger('Http', 'SnapcastMdns');
  private streamRegistration: MdnsRegistration | null = null;
  private httpRegistration: MdnsRegistration | null = null;

  constructor(private readonly mdns: MdnsPort) {}

  public advertise(options: SnapcastAdvertiseOptions): void {
    this.stop();
    const host = this.normalizeHost(options.host);
    this.streamRegistration = this.mdns.publish({
      name: options.name,
      type: 'snapcast',
      protocol: 'tcp',
      port: options.streamPort,
      host,
    });
    this.httpRegistration = this.mdns.publish({
      name: options.name,
      type: 'snapcast-http',
      protocol: 'tcp',
      port: options.httpPort,
      host,
    });
    this.log.info('Snapcast services advertised via mDNS', {
      name: options.name,
      host,
      streamPort: options.streamPort,
      httpPort: options.httpPort,
    });
  }

  public stop(): void {
    this.streamRegistration?.stop();
    this.httpRegistration?.stop();
    this.streamRegistration = null;
    this.httpRegistration = null;
  }

  private normalizeHost(host?: string): string | undefined {
    const trimmed = host?.trim() ?? '';
    if (trimmed) {
      if (net.isIP(trimmed)) {
        const hostname = os.hostname();
        if (!hostname) {
          return undefined;
        }
        const normalized = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
        return normalized.includes('.') ? normalized : `${normalized}.local`;
      }
      const normalized = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
      return normalized.includes('.') ? normalized : `${normalized}.local`;
    }
    const hostname = os.hostname();
    if (!hostname) {
      return undefined;
    }
    const normalized = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
    return normalized.includes('.') ? normalized : `${normalized}.local`;
  }
}
