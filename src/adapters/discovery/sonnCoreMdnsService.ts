import type { HttpServerConfig } from '@/config/http';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { MdnsPort } from '@/ports/MdnsPort';
import { resolveMdnsHost } from '@/shared/utils/net';
import { normalizeMacId } from '@/shared/utils/mac';
import { readBuildVersion } from '@/shared/serverVersion';
import { SonnCoreMdnsAdvertiser } from '@/adapters/discovery/sonnCoreMdnsAdvertiser';
import type { MdnsLifecycleService } from '@/adapters/discovery/mdnsLifecycle';
import { API_ROOT } from '@/adapters/http/api/apiHandler';

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
        // Versioned, so a client that finds us over mDNS lands on the contract it was
        // built against rather than on whatever the newest one happens to be.
        api: API_ROOT,
        /**
         * This server's identity, byte-identical to `selfId` from
         * `GET /api/v1/audio-servers`. A discovering client needs something stable to
         * recognise us by across restarts and address changes — a Home Assistant config
         * flow keys its entry on it — and the instance name will not do: it is the
         * configured display name and changes when someone renames the server.
         */
        id: normalizeMacId(mac) ?? undefined,
        /** What is running, so a client can tell whether a surface it needs exists yet. */
        version: readBuildVersion(),
        // Where a Sonn Client registers and polls. Advertised even though the client has these as
        // defaults, so the paths can move without needing a release on every speaker.
        client_register: '/api/sonnclients/register',
        client_status: '/api/sonnclients/{device_id}/status',
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
