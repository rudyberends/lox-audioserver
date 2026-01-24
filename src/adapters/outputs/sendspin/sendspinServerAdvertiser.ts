import type { HttpServerConfig } from '@/config/http';
import type { ConfigPort } from '@/ports/ConfigPort';
import { resolveMdnsHost } from '@/shared/utils/net';
import type { SendspinClientConnector } from '@/adapters/outputs/sendspin/sendspinClientConnector';
import type { MdnsLifecycleService } from '@/adapters/discovery/mdnsLifecycle';

export class SendspinServerAdvertiser implements MdnsLifecycleService {
  private started = false;

  constructor(
    private readonly config: HttpServerConfig,
    private readonly configPort: ConfigPort,
    private readonly connector: SendspinClientConnector,
  ) {}

  public start(): void {
    if (this.started) {
      return;
    }
    const systemName = this.configPort.getSystemConfig()?.audioserver?.name || 'Lox Audio Server';
    this.connector.advertiseServer({
      port: this.config.port,
      host: resolveMdnsHost(this.config.host),
      path: '/sendspin',
      name: systemName,
    });
    this.started = true;
  }

  public stop(): void {
    if (!this.started) {
      return;
    }
    this.connector.stopAdvertising();
    this.started = false;
  }
}
