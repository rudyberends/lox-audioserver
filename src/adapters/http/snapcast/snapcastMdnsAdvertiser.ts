import Bonjour from 'bonjour-service';
import net from 'node:net';
import os from 'node:os';
import { createLogger } from '@/shared/logging/logger';

type SnapcastAdvertiseOptions = {
  name: string;
  host?: string;
  streamPort: number;
  jsonrpcPort: number;
};

export class SnapcastMdnsAdvertiser {
  private readonly log = createLogger('Http', 'SnapcastMdns');
  private bonjour: Bonjour | null = null;
  private streamService: ReturnType<Bonjour['publish']> | null = null;
  private rpcService: ReturnType<Bonjour['publish']> | null = null;

  public advertise(options: SnapcastAdvertiseOptions): void {
    const bonjour = this.ensureBonjour();
    this.stop();
    const host = this.normalizeHost(options.host);
    this.streamService = bonjour.publish({
      name: options.name,
      type: 'snapcast',
      protocol: 'tcp',
      port: options.streamPort,
      host,
    });
    this.rpcService = bonjour.publish({
      name: options.name,
      type: 'snapcast-jsonrpc',
      protocol: 'tcp',
      port: options.jsonrpcPort,
      host,
    });
    this.streamService.start?.();
    this.rpcService.start?.();
    this.log.info('Snapcast services advertised via mDNS', {
      name: options.name,
      host,
      streamPort: options.streamPort,
      jsonrpcPort: options.jsonrpcPort,
    });
  }

  public stop(): void {
    const services = [this.streamService, this.rpcService];
    for (const service of services) {
      if (!service) continue;
      try {
        service.stop?.();
      } catch {
        /* ignore */
      }
    }
    this.streamService = null;
    this.rpcService = null;
  }

  private ensureBonjour(): Bonjour {
    if (!this.bonjour) {
      this.bonjour = new Bonjour();
    }
    return this.bonjour;
  }

  private normalizeHost(host?: string): string | undefined {
    const trimmed = host?.trim() ?? '';
    const candidate = trimmed && !net.isIP(trimmed) ? trimmed : os.hostname();
    if (!candidate) {
      return undefined;
    }
    return candidate.includes('.') ? candidate : `${candidate}.local`;
  }
}
