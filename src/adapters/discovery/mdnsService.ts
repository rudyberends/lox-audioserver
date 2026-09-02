import Bonjour from 'bonjour-service';
import { createLogger } from '@/shared/logging/logger';
import { advertisableIpv4Addresses } from '@/shared/utils/net';
import type {
  MdnsBrowseOptions,
  MdnsBrowser,
  MdnsPort,
  MdnsPublishOptions,
  MdnsRegistration,
  MdnsServiceRecord,
} from '@/ports/MdnsPort';

type AdvertisedRecord = { type: string; data?: unknown };

export class MdnsService implements MdnsPort {
  private readonly log = createLogger('Discovery', 'Mdns');
  /**
   * Made when first needed and thrown away by {@link shutdown}, rather than made once and kept.
   *
   * This service outlives the services that use it: a soft restart stops everything and starts it
   * again on the same object. Destroying the responder on the way down and reusing the corpse on
   * the way up meant publishing silently did nothing afterwards — the server kept running, kept
   * answering HTTP, and simply stopped existing on the network. A speaker looking for it found
   * nothing, with no error anywhere to explain why.
   */
  private instance: Bonjour | null = null;

  private get bonjour(): Bonjour {
    this.instance ??= new Bonjour();
    return this.instance;
  }

  public publish(options: MdnsPublishOptions): MdnsRegistration {
    const service = this.bonjour.publish({
      name: options.name ?? 'Lox Audio Server',
      type: options.type,
      protocol: options.protocol ?? 'tcp',
      port: options.port,
      host: options.host,
      txt: options.txt,
    });
    this.restrictAdvertisedAddresses(service, options.type, options.addresses);
    service.start?.();
    return {
      stop: () => {
        try {
          service.stop?.();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log.debug('mdns unpublish failed', { message, type: options.type });
        }
      },
    };
  }

  /**
   * Drop A-records for container/VM bridge addresses from a published service.
   *
   * bonjour-service builds its A/AAAA records by walking os.networkInterfaces() on every query and
   * ignores the `addresses` field, so there is no option to narrow this: a host running Docker
   * advertises 172.x bridge addresses alongside its real LAN address. Clients then pick one of
   * those at random (mDNS address sets are unordered) and either time out or -- worse -- reach a
   * different machine that happens to use the same private range on its own side.
   *
   * Wrapping records() is the narrowest place to fix it; the alternative is patching the library.
   *
   * A caller that knows exactly which address it wants reached passes `pinned`, and then that set
   * is exhaustive: an IPv6 address it did not name is dropped along with the extra A-records.
   * Without one only IPv4 is narrowed and IPv6 passes through, as it always did.
   */
  private restrictAdvertisedAddresses(service: unknown, type: string, pinned?: string[]): void {
    const target = service as { records?: () => AdvertisedRecord[] };
    const original = target.records;
    if (typeof original !== 'function') {
      // Older/newer bonjour-service without records(): leave the advertisement as-is rather than
      // failing to publish at all.
      this.log.debug('mdns records() unavailable; advertising every interface', { type });
      return;
    }
    target.records = () => {
      const records = original.call(service);
      const allowed = new Set(pinned?.length ? pinned : advertisableIpv4Addresses());
      if (!allowed.size) {
        return records;
      }
      return records.filter((record) => {
        const narrowed = record.type === 'A' || (record.type === 'AAAA' && !!pinned?.length);
        return !narrowed || typeof record.data !== 'string' || allowed.has(record.data);
      });
    };
  }

  public browse(
    options: MdnsBrowseOptions,
    onService: (service: MdnsServiceRecord) => void,
  ): MdnsBrowser {
    const browser = this.bonjour.find(
      { type: options.type, protocol: options.protocol ?? 'tcp' },
      (service) => onService(service as MdnsServiceRecord),
    );
    browser.start();
    return {
      stop: () => {
        try {
          browser.stop?.();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log.debug('mdns browse stop failed', { message, type: options.type });
        }
      },
    };
  }

  public shutdown(): void {
    // Nothing to tear down until something has been published or browsed; asking for the responder
    // here would create one only to destroy it.
    const instance = this.instance;
    this.instance = null;
    if (!instance) {
      return;
    }
    try {
      instance.destroy?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug('mdns shutdown failed', { message });
    }
  }
}
