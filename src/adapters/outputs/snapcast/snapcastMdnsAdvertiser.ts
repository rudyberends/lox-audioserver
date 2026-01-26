import net from 'node:net';
import os from 'node:os';
import { createLogger } from '@/shared/logging/logger';
import type { MdnsPort, MdnsRegistration } from '@/ports/MdnsPort';

type SnapcastAdvertiseOptions = {
  name: string;
  host?: string;
  streamPort: number;
  jsonrpcPort: number;
};

export class SnapcastMdnsAdvertiser {
  private readonly log = createLogger('Http', 'SnapcastMdns');
  private streamRegistration: MdnsRegistration | null = null;
  private rpcRegistration: MdnsRegistration | null = null;

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
    this.rpcRegistration = this.mdns.publish({
      name: options.name,
      type: 'snapcast-jsonrpc',
      protocol: 'tcp',
      port: options.jsonrpcPort,
      host,
    });
    this.log.info('Snapcast services advertised via mDNS', {
      name: options.name,
      host,
      streamPort: options.streamPort,
      jsonrpcPort: options.jsonrpcPort,
    });
  }

  public stop(): void {
    this.streamRegistration?.stop();
    this.rpcRegistration?.stop();
    this.streamRegistration = null;
    this.rpcRegistration = null;
  }

  private normalizeHost(host?: string): string | undefined {
    const trimmed = host?.trim() ?? '';
    if (trimmed) {
      if (net.isIP(trimmed)) {
        return trimmed;
      }
      return trimmed.includes('.') ? trimmed : `${trimmed}.local`;
    }
    const hostname = os.hostname();
    if (!hostname) {
      return undefined;
    }
    return hostname.includes('.') ? hostname : `${hostname}.local`;
  }
}
