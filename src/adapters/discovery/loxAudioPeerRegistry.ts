import { createLogger } from '@/shared/logging/logger';
import type { MdnsBrowser, MdnsPort, MdnsServiceRecord } from '@/ports/MdnsPort';

const LOX_AUDIO_MDNS_TYPE = 'loxaudio';

/**
 * Tracks the lox-audioserver instances seen on the LAN via mDNS (_loxaudio._tcp), keyed by the
 * macId each advertises in its TXT records. Real Loxone audioservers share the protocol but do not
 * advertise this service, so this is how we tell our own implementations apart — letting the admin
 * UI offer only servers it can actually administer. Grow-only: it identifies a server's TYPE, not
 * its liveness (a peer going offline is still a lox-audioserver; switching to a dead one just fails).
 */
export class LoxAudioPeerRegistry {
  private readonly log = createLogger('Http', 'LoxAudioPeers');
  private readonly macs = new Set<string>();
  private browser: MdnsBrowser | null = null;

  constructor(private readonly mdns: MdnsPort) {}

  public start(): void {
    if (this.browser) return;
    this.browser = this.mdns.browse({ type: LOX_AUDIO_MDNS_TYPE, protocol: 'tcp' }, (service) => {
      const mac = this.readMac(service);
      if (mac && !this.macs.has(mac)) {
        this.macs.add(mac);
        this.log.debug('discovered lox-audioserver peer', { mac, host: service.host });
      }
    });
  }

  public stop(): void {
    this.browser?.stop();
    this.browser = null;
  }

  /** True when an audioserver with this macId advertises itself as lox-audioserver over mDNS. */
  public has(macId: string): boolean {
    return this.macs.has(macId.trim().toUpperCase());
  }

  private readMac(service: MdnsServiceRecord): string | null {
    const raw = service.txt?.mac;
    if (typeof raw !== 'string') return null;
    const mac = raw.trim().toUpperCase();
    return mac || null;
  }
}
