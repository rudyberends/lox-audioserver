import type { HttpServerConfig } from '@/config/http';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { MdnsPort } from '@/ports/MdnsPort';
import { resolveMdnsHost } from '@/shared/utils/net';
import { SonnCoreMdnsAdvertiser } from '@/adapters/discovery/sonnCoreMdnsAdvertiser';
import type { MdnsLifecycleService } from '@/adapters/discovery/mdnsLifecycle';

export class SonnCoreMdnsService implements MdnsLifecycleService {
  private readonly advertiser: SonnCoreMdnsAdvertiser;
  private started = false;

  constructor(
    private readonly config: HttpServerConfig,
    private readonly configPort: ConfigPort,
    mdns: MdnsPort,
  ) {
    this.advertiser = new SonnCoreMdnsAdvertiser(mdns);
  }

  public start(): void {
    if (this.started) {
      return;
    }
    const systemConfig = this.configPort.getSystemConfig();
    const systemName = systemConfig?.audioserver?.name || 'Lox Audio Server';
    const systemIp = systemConfig?.audioserver?.ip?.trim();
    const mac = systemConfig?.audioserver?.macId?.trim();
    this.advertiser.advertise({
      name: systemName,
      host: resolveMdnsHost(this.config.host, systemIp),
      port: this.config.port,
      txt: {
        api: '/api',
        linein: '/api/linein',
        linein_register: '/api/linein/bridges/register',
        linein_status: '/api/linein/bridges/{bridge_id}/status',
        mac: mac ? mac.toUpperCase() : undefined,
      },
    });
    this.started = true;
  }

  public stop(): void {
    if (!this.started) {
      return;
    }
    this.advertiser.stop();
    this.started = false;
  }
}
