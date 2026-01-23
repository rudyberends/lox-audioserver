import dgram from 'node:dgram';
import type { LoxoneHttpConfig } from '@/config/loxone';
import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';

const DEFAULT_PORT = 7070;

export class LoxoneUdpDiscovery {
  private readonly log = createLogger('Loxone', 'UDPDiscovery');
  private socket: dgram.Socket | null = null;
  private responder: dgram.Socket | null = null;
  private responsePayload = Buffer.alloc(0);
  private readonly fixedTv = '3';
  private readonly fixedDi = '1';

  public start(config: LoxoneHttpConfig, configPort: ConfigPort, port: number = DEFAULT_PORT): void {
    if (this.socket) {
      return;
    }

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    const responder = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.responder = responder;
    this.responsePayload = Buffer.from(
      this.buildPayload(config, configPort, this.fixedTv, this.fixedDi),
      'utf8',
    );

    socket.on('error', (error) => {
      this.log.warn('udp discovery socket error', {
        message: error instanceof Error ? error.message : String(error),
      });
    });

    socket.on('message', (msg, rinfo) => {
      const payload = msg.length ? msg : Buffer.alloc(0);
      this.log.info('udp discovery probe received', {
        from: `${rinfo.address}:${rinfo.port}`,
        length: payload.length,
        payload: payload.length <= 32 ? payload.toString('hex') : undefined,
      });

      responder.send(this.responsePayload, rinfo.port, rinfo.address, (err) => {
        if (err) {
          this.log.warn('udp discovery response failed', {
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        this.log.info('udp discovery response sent', {
          to: `${rinfo.address}:${rinfo.port}`,
          length: this.responsePayload.length,
          tv: this.fixedTv,
          di: this.fixedDi,
        });
      });
    });

    responder.bind(this.resolveUdpPort(config), () => {
      this.log.info('udp discovery responder ready', {
        port: this.resolveUdpPort(config),
      });
    });

    socket.bind(port, () => {
      this.log.info('udp discovery listener started', {
        port,
        response: this.responsePayload.toString('utf8'),
      });
    });
  }

  public stop(): void {
    if (!this.socket) {
      return;
    }
    const socket = this.socket;
    const responder = this.responder;
    this.socket = null;
    this.responder = null;
    socket.close(() => {
      this.log.info('udp discovery listener stopped');
    });
    responder?.close(() => {
      this.log.info('udp discovery responder stopped');
    });
  }

  private buildPayload(config: LoxoneHttpConfig, configPort: ConfigPort, tv: string, di: string): string {
    const systemConfig = configPort.getSystemConfig();
    const configuredName = systemConfig?.audioserver?.name?.trim();
    const friendlyName =
      configuredName && configuredName.toLowerCase() !== 'unconfigured'
        ? configuredName
        : config.mdns.name || 'lox-audioserver';
    const hostname = this.sanitizeHostname(config.mdns.hostname || friendlyName);
    const macId = systemConfig?.audioserver?.macId?.trim();

    const payload = {
      t: 'Audioserver',
      tv,
      n: friendlyName,
      s: this.formatMacAddress(macId || config.macAddress),
      v: '16.1.10.01',
      p: String(this.resolveUdpPort(config)),
      hn: hostname,
      di,
    };

    return JSON.stringify(payload);
  }

  private sanitizeHostname(value: string): string {
    const trimmed = value.trim();
    const withoutLocal = trimmed.endsWith('.local') ? trimmed.slice(0, -6) : trimmed;
    return withoutLocal.replace(/\s+/g, '-').replace(/\./g, '-') || 'audioserver';
  }

  private formatMacAddress(raw: string): string {
    const normalized = raw.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
    if (normalized.length !== 12) {
      return raw;
    }
    return normalized.match(/.{2}/g)?.join(':') ?? raw;
  }

  private resolveUdpPort(config: LoxoneHttpConfig): number {
    const appServer = config.servers.find((server) => server.name === 'appHttp');
    return appServer?.port ?? config.mdns.port;
  }

}
