import net from 'node:net';
import { createLogger } from '@/core/logging/logger';
import { snapcastCore } from '@/modules/http/snapcast/snapcastCore';

const DEFAULT_TCP_PORT = 1704;

export class SnapcastTcpServer {
  private readonly log = createLogger('Http', 'SnapcastTcp');
  private server?: net.Server;
  private host: string | null = null;
  private port: number | null = null;

  public async start(): Promise<void> {
    if (this.server) {
      return;
    }
    const port = this.resolvePort();
    const host = this.resolveHost();
    this.server = net.createServer((socket) => snapcastCore.handleTcpConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!
        .listen(port, host, () => {
          this.log.info('snapcast tcp listening', { host, port });
          this.host = host;
          this.port = port;
          resolve();
        })
        .on('error', reject);
    });
  }

  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = undefined;
    this.host = null;
    this.port = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  public getAdvertisePort(): number | null {
    return this.port;
  }

  private resolvePort(): number {
    const raw = process.env.SNAPCAST_TCP_PORT;
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 65535) {
      return parsed;
    }
    return DEFAULT_TCP_PORT;
  }

  private resolveHost(): string {
    return process.env.SNAPCAST_TCP_HOST ?? '0.0.0.0';
  }
}
