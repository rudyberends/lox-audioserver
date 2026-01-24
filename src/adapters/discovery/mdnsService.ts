import Bonjour from 'bonjour-service';
import { createLogger } from '@/shared/logging/logger';
import type {
  MdnsBrowseOptions,
  MdnsBrowser,
  MdnsPort,
  MdnsPublishOptions,
  MdnsRegistration,
  MdnsServiceRecord,
} from '@/ports/MdnsPort';

export class MdnsService implements MdnsPort {
  private readonly log = createLogger('Discovery', 'Mdns');
  private readonly bonjour = new Bonjour();

  public publish(options: MdnsPublishOptions): MdnsRegistration {
    const service = this.bonjour.publish({
      name: options.name ?? 'Lox Audio Server',
      type: options.type,
      protocol: options.protocol ?? 'tcp',
      port: options.port,
      host: options.host,
      txt: options.txt,
    });
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
    try {
      this.bonjour.destroy?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug('mdns shutdown failed', { message });
    }
  }
}
