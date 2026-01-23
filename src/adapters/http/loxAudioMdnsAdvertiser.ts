import Bonjour from 'bonjour-service';
import { createLogger } from '@/shared/logging/logger';

type AdvertiseOptions = {
  name: string;
  host?: string;
  port: number;
  txt?: Record<string, string | undefined>;
};

export class LoxAudioMdnsAdvertiser {
  private readonly log = createLogger('Http', 'LoxAudioMdns');
  private bonjour: Bonjour | null = null;
  private service: ReturnType<Bonjour['publish']> | null = null;

  public advertise(options: AdvertiseOptions): void {
    const bonjour = this.ensureBonjour();
    this.stop();
    const txt = this.cleanTxt(options.txt);
    const service = bonjour.publish({
      name: options.name,
      type: 'loxaudio',
      protocol: 'tcp',
      port: options.port,
      host: options.host,
      txt,
    });
    service.start?.();
    this.service = service;
    this.log.info('Lox Audio server advertised via mDNS', {
      name: options.name,
      host: options.host,
      port: options.port,
      txt,
    });
  }

  public stop(): void {
    if (!this.service) {
      return;
    }
    try {
      this.service.stop?.();
    } catch {
      /* ignore */
    }
    this.service = null;
  }

  private ensureBonjour(): Bonjour {
    if (!this.bonjour) {
      this.bonjour = new Bonjour();
    }
    return this.bonjour;
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
