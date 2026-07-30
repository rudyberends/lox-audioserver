import { createLogger } from '@/shared/logging/logger';
import type { MdnsBrowser, MdnsPort, MdnsServiceRecord } from '@/ports/MdnsPort';
import { normalizeMacId } from '@/shared/utils/mac';

const LOX_AUDIO_MDNS_TYPE = 'sonncore';

/**
 * Tracks the sonn-core instances seen on the LAN via mDNS (_sonncore._tcp), keyed by the
 * macId each advertises in its TXT records. Real Loxone audioservers share the protocol but do not
 * advertise this service, so this is how we tell our own implementations apart — letting the admin
 * UI offer only servers it can actually administer. Grow-only: it identifies a server's TYPE, not
 * its liveness (a peer going offline is still a sonn-core; switching to a dead one just fails).
 */
export class SonnCorePeerRegistry {
  private readonly log = createLogger('Http', 'SonnCorePeers');
  private readonly macs = new Set<string>();
  private readonly hosts = new Set<string>();
  private browser: MdnsBrowser | null = null;

  constructor(private readonly mdns: MdnsPort) {}

  public start(): void {
    if (this.browser) return;
    this.browser = this.mdns.browse({ type: LOX_AUDIO_MDNS_TYPE, protocol: 'tcp' }, (service) => {
      const mac = this.readMac(service);
      const addresses = [service.host, ...(service.addresses ?? [])]
        .map((value) => this.normalizeHost(value))
        .filter((value): value is string => value !== null);
      const newMac = mac !== null && !this.macs.has(mac);
      const newHost = addresses.some((host) => !this.hosts.has(host));
      if (mac) this.macs.add(mac);
      for (const host of addresses) this.hosts.add(host);
      if (newMac || newHost) {
        this.log.debug('discovered sonn-core peer', { mac, host: service.host, addresses });
      }
    });
  }

  public stop(): void {
    this.browser?.stop();
    this.browser = null;
  }

  /** True when an audioserver with this macId advertises itself as sonn-core over mDNS. */
  public has(macId: string, ...addresses: Array<string | null | undefined>): boolean {
    const normalized = normalizeMacId(macId);
    if (normalized !== null && this.macs.has(normalized)) return true;
    return addresses.some((address) => {
      const host = this.normalizeHost(address);
      return host !== null && this.hosts.has(host);
    });
  }

  private readMac(service: MdnsServiceRecord): string | null {
    const raw = service.txt?.mac ?? service.txt?.macId;
    if (typeof raw !== 'string') return null;
    return normalizeMacId(raw);
  }

  private normalizeHost(value: string | null | undefined): string | null {
    const normalized = value?.trim().toLowerCase().replace(/\.$/, '');
    return normalized || null;
  }
}
