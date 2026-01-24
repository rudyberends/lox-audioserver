import net from 'node:net';
import { createLogger } from '@/shared/logging/logger';
import type { SnapcastCore } from '@/adapters/outputs/snapcast/snapcastCore';

const DEFAULT_TCP_PORT = 1704;

export class SnapcastTcpServer {
  private readonly log = createLogger('Http', 'SnapcastTcp');
  private server?: net.Server;
  private host: string | null = null;
  private port: number | null = null;

  constructor(private readonly core: SnapcastCore) {}

  public async start(): Promise<void> {
    if (this.server) {
      return;
    }
    const port = this.resolvePort();
    const host = this.resolveHost();
    this.server = net.createServer((socket) => this.core.handleTcpConnection(socket));
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
    return DEFAULT_TCP_PORT;
  }

  private resolveHost(): string {
    return '0.0.0.0';
  }
}
