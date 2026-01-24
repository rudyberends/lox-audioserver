import { createLogger } from '@/shared/logging/logger';
import type { MdnsPort, MdnsRegistration } from '@/ports/MdnsPort';

type AdvertiseOptions = {
  name: string;
  host?: string;
  port: number;
  txt?: Record<string, string | undefined>;
};

export class LoxAudioMdnsAdvertiser {
  private readonly log = createLogger('Http', 'LoxAudioMdns');
  private registration: MdnsRegistration | null = null;

  constructor(private readonly mdns: MdnsPort) {}

  public advertise(options: AdvertiseOptions): void {
    this.stop();
    const txt = this.cleanTxt(options.txt);
    this.registration = this.mdns.publish({
      name: options.name,
      type: 'loxaudio',
      protocol: 'tcp',
      port: options.port,
      host: options.host,
      txt,
    });
    this.log.info('Lox Audio server advertised via mDNS', {
      name: options.name,
      host: options.host,
      port: options.port,
      txt,
    });
  }

  public stop(): void {
    this.registration?.stop();
    this.registration = null;
  }

  private cleanTxt(
    txt?: Record<string, string | undefined>,
  ): Record<string, string> | undefined {
    if (!txt) {
      return undefined;
    }
    const entries = Object.entries(txt).filter((entry) => {
      const value = entry[1];
      return typeof value === 'string' && value.trim().length > 0;
    }) as Array<[string, string]>;
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
}
