import Bonjour from 'bonjour-service';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import type { LoxoneMdnsConfig } from '@/config/loxone';
import { createLogger } from '@/core/logging/logger';
import { getSystemConfig } from '@/domain/config/configStore';

/**
 * Publishes the Loxone HTTP endpoint via mDNS so setup tools can discover it.
 */
export class LoxoneMdnsAdvertiser {
  private readonly log = createLogger('Loxone', 'mDNS');
  private bonjour: Bonjour | null = null;
  private service: ReturnType<Bonjour['publish']> | null = null;

  public publish(config: LoxoneMdnsConfig, fallbackHost?: string): void {
    try {
      this.startService(config, fallbackHost);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('failed to publish mDNS entry', { message });
    }
  }

  public stop(): void {
    if (this.service) {
      try {
        this.service.stop?.();
      } catch {
        /* ignore */
      }
      this.service = null;
    }
    if (this.bonjour) {
      try {
        this.bonjour.destroy?.();
      } catch {
        /* ignore */
      }
      this.bonjour = null;
    }
  }

  private startService(config: LoxoneMdnsConfig, fallbackHost?: string): void {
    const bonjour = this.ensureBonjour();
    const serviceName = this.resolveServiceName(config.name);
    const { host, label } = this.resolveHostName(config.hostname, config.host ?? fallbackHost, serviceName);
    const advertiseAddress = this.pickAdvertiseAddress(config.host ?? fallbackHost);
    const txt = this.buildTxt(config, label);

    this.log.info('preparing mDNS service', { serviceName, host, label, advertiseAddress, txt });

    if (this.service) {
      try {
        this.service.stop?.();
      } catch {
        /* ignore */
      }
    }

    this.service = bonjour.publish({
      name: serviceName,
      type: config.type,
      protocol: 'tcp',
      port: config.port,
      host,
      disableIPv6: true,
      probe: false,
      txt,
    });

    if (advertiseAddress && this.service) {
      const originalRecords = this.service.records.bind(this.service);
      this.service.records = () => {
        const base = originalRecords().filter(
          (record) => record.type !== 'A' && record.type !== 'AAAA',
        );

        base.push({
          name: host,
          type: 'A',
          ttl: 120,
          data: advertiseAddress,
        });

        return base;
      };
    }

    this.service.start?.();
    this.log.info('mDNS service advertised', {
      name: serviceName,
      port: config.port,
      host: host ?? 'local',
      txt,
    });
  }

  private resolveServiceName(defaultName: string): string {
    const configuredName = getSystemConfig()?.audioserver?.name?.trim();
    if (configuredName && configuredName.toLowerCase() !== 'unconfigured') {
      return configuredName;
    }
    return defaultName;
  }

  private resolveHostName(
    configuredHostname?: string,
    preferredHost?: string,
    serviceName?: string,
  ): { host: string; label: string } {
    const preferredName =
      configuredHostname ||
      (preferredHost && !isIP(preferredHost) ? preferredHost : undefined) ||
      serviceName ||
      'audioserver';

    const label = this.sanitizeLabel(
      this.stripLocalSuffix(preferredName) || 'audioserver',
    );

    // Force SRV target and A owner to the same label with .local suffix so A lookups succeed.
    const host = `${label}.local`;
    return { host, label };
  }

  private buildTxt(
    config: LoxoneMdnsConfig,
    label: string,
  ): Record<string, string> {
    const hostname = this.stripLocalSuffix(config.hostname ?? label);
    return {
      t: config.deviceType,
      v: config.version,
      tv: config.txtVersion,
      p: String(config.port),
      di: config.deviceInstance,
      hn: hostname || label,
    };
  }

  private normalizeHostName(value?: string): string | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed === '0.0.0.0') return undefined;
    return trimmed;
  }

  private sanitizeLabel(label: string): string {
    // Bonjour will sanitize internally, but we also drop illegal dots/spaces for consistency.
    const normalized = label.replace(/\s+/g, '-').replace(/\./g, '-');
    return normalized || 'audioserver';
  }

  private stripLocalSuffix(value: string): string {
    return value.endsWith('.local') ? value.slice(0, -6) : value;
  }

  private pickAdvertiseAddress(preferredHost?: string): string | undefined {
    const normalized = this.normalizeHostName(preferredHost);
    if (normalized && isIP(normalized)) {
      return normalized;
    }
    return this.pickLocalAddress();
  }

  private pickLocalAddress(): string | undefined {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal && net.address) {
          return net.address;
        }
      }
    }
    return undefined;
  }

  private ensureBonjour(): Bonjour {
    if (!this.bonjour) {
      this.bonjour = new Bonjour();
    }
    return this.bonjour;
  }
}
