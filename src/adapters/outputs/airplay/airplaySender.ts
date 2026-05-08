import { Readable } from 'node:stream';
import { networkInterfaces } from 'node:os';
import { createLogger } from '@/shared/logging/logger';
import { LoxAirplaySender } from '@lox-audioserver/node-airplay-sender';
export type AirplaySenderOverrides = Record<string, unknown>;
import { airplayTxtSuggestsAirPlay2, discoverAirplayDevices } from '@/adapters/outputs/airplay/airplayDiscovery';
import type { AirplayDeviceDescriptor } from '@/adapters/outputs/airplay/airplayDiscovery';
import { ntpToUnixMs } from '@/shared/airplayNtp';

export interface AirplaySenderConfig {
  host: string;
  port?: number;
  name?: string;
  password?: string;
  iface?: string;
  forceAp2?: boolean;
  txt?: string[] | string;
  mdnsHostname?: string;
  address?: string;
  disableDiscovery?: boolean;
  debug?: boolean;
  config?: AirplaySenderOverrides;
  onSessionEnded?: (event: { reason: string; key?: string; message?: string }) => void;
}

type ResolvedAirplayConfig = { port?: number | null; forceAp2?: boolean; txt?: string[] };

export class AirplaySender {
  private readonly log = createLogger('Output', 'AirPlaySender');
  private currentVolume = 30;
  private startToken = 0;
  private sourceStream: Readable | null = null;
  private readonly flowBuffers = new Set<FlowBuffer>();
  private sender: LoxAirplaySender | null = null;
  private senderAbort?: AbortController;
  private resolvedConfig?: ResolvedAirplayConfig;

  constructor(
    private readonly config: AirplaySenderConfig,
    private readonly context?: { zoneId: number; zoneName: string },
  ) {}

  /**
   * Adjust volume for a running session.
   */
  public async setVolume(volume: number): Promise<boolean> {
    this.currentVolume = Math.min(100, Math.max(0, Math.round(volume)));
    if (this.sender) {
      try {
        this.sender.setVolume(this.currentVolume);
        return true;
      } catch (err: unknown) {
        this.log.warn('airplay sender volume failed', {
          host: this.config.host,
          message: (err as { message?: string } | null)?.message || String(err),
        });
      }
    }
    return false;
  }

  public async start(inputUrl: string | null, volume?: number, sourceStream?: Readable | null, ntpStart?: bigint): Promise<void> {
    this.currentVolume = Math.min(100, Math.max(0, Math.round(volume ?? this.currentVolume)));
    this.sourceStream = sourceStream ?? null;
    const startTimeMs = ntpStart ? ntpToUnixMs(ntpStart) : undefined;
    const ok = await this.startSender(inputUrl, this.sourceStream, startTimeMs);
    if (ok) {
      this.log.info('airplay sender started', { host: this.config.host });
    } else {
      this.log.error('airplay sender start failed; sender not started', { host: this.config.host });
    }
  }

  public async stop(): Promise<void> {
    this.startToken++;
    if (this.sourceStream) {
      try {
        this.sourceStream.destroy();
      } catch {
        /* ignore */
      }
      this.sourceStream = null;
    }
    this.flowBuffers.clear();
    this.stopSender();
  }

  public isRunning(): boolean {
    return Boolean(this.sender);
  }

  public async updateMetadata(payload: {
    title?: string;
    artist?: string;
    album?: string;
    cover?: { data: Buffer; mime?: string };
    coverUrl?: string;
    elapsedMs?: number;
    durationMs?: number;
  }): Promise<void> {
    if (!this.sender) return;
    await this.sender.setMetadata(payload);
  }

  /**
   * Release buffered data to all writers. Used by flowSession as a simple barrier.
   */
  public releaseBuffers(): void {
    for (const fb of this.flowBuffers) {
      fb.ready();
    }
  }

  public clearBuffers(): void {
    for (const fb of this.flowBuffers) {
      fb.reset(true);
    }
  }

  // --- Sender helpers ------------------------------------------------------

  private async startSender(inputUrl: string | null, sourceStream?: Readable | null, startTimeMs?: number): Promise<boolean> {
    this.stopSender();
    if (!inputUrl && !sourceStream) {
      this.log.warn('airplay sender skipped; no input');
      return false;
    }

    const resolved = await this.resolveDeviceConfig();
    const sender = new LoxAirplaySender();
    const fallbackTxt = Array.isArray(this.config.txt) ? this.config.txt : this.config.txt ? [this.config.txt] : [];
    const resolvedForceAp2 = resolved.forceAp2 ?? this.config.forceAp2;
    const resolvedPort = resolved.port === null ? undefined : (resolved.port ?? this.config.port);
    const airplay2 = typeof resolvedForceAp2 === 'boolean' ? resolvedForceAp2 : false;
    const opts = {
      host: this.config.host,
      port: resolvedPort,
      name: this.config.name,
      password: this.config.password,
      volume: this.currentVolume,
      airplay2,
      txt: resolved.txt ?? fallbackTxt,
      startTimeMs,
      debug: this.config.debug ?? false,
      metrics: true,
      config: this.config.config,
      log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => {
        // AirPlay targets can be chatty (e.g. per-second SETPROGRESS). Logging those at high volume
        // can easily add enough overhead to cause audible stutter. Only surface request-level chatter
        // when explicit output debug is enabled.
        if ((this.config.debug ?? false) !== true && message.includes('Receiving request')) {
          return;
        }
        const payload: Record<string, unknown> = {
          host: this.config.host,
          zoneId: this.context?.zoneId,
          zoneName: this.context?.zoneName,
        };
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          Object.assign(payload, data as Record<string, unknown>);
        } else if (data !== undefined) {
          payload.data = data;
        }
        const logFn =
          level === 'error' ? this.log.error : level === 'warn' ? this.log.warn : level === 'info' ? this.log.info : this.log.debug;
        logFn.call(this.log, message, payload);
      },
    };

    const ok = sender.start(opts, (evt: any) => {
      const basePayload = {
        event: evt?.event,
        message: evt?.message,
        host: this.config.host,
        zoneId: this.context?.zoneId,
        zoneName: this.context?.zoneName,
      };
      if (evt?.event === 'metrics') {
        this.log.debug('airplay sender metrics', {
          ...basePayload,
          detail: evt?.detail,
        });
        return;
      }
      if (evt?.event === 'session-ended') {
        const reason =
          typeof evt?.detail?.reason === 'string' ? evt.detail.reason : typeof evt?.message === 'string' ? evt.message : 'unknown';
        this.log.info('airplay sender session ended', {
          ...basePayload,
          reason,
          detail: evt?.detail,
        });
        this.config.onSessionEnded?.({
          reason,
          key: typeof evt?.detail?.key === 'string' ? evt.detail.key : undefined,
          message: typeof evt?.message === 'string' ? evt.message : undefined,
        });
        return;
      }
      if (evt?.event === 'device' && evt?.message === 'pair_failed') {
        this.clearAutoResolvedConfig('pair_failed');
      }
      this.log.debug('airplay sender event', basePayload);
    });
    if (!ok) {
      this.log.warn('airplay sender start returned false', { host: this.config.host });
      this.stopSender();
      return false;
    }

    this.sender = sender;
    const token = ++this.startToken;
    this.senderAbort = new AbortController();
    this.flowBuffers.clear();

    try {
      if (sourceStream) {
        this.pipeSenderStream(sourceStream, token);
        return true;
      }
      if (inputUrl) {
        await this.pipeSenderFromUrl(inputUrl, token, this.senderAbort.signal);
        return true;
      }
    } catch (err) {
      this.log.warn('airplay sender start failed', {
        host: this.config.host,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    this.stopSender();
    return false;
  }

  private stopSender(): void {
    if (this.senderAbort) {
      try {
        this.senderAbort.abort();
      } catch {
        /* ignore */
      }
      this.senderAbort = undefined;
    }
    if (this.sender) {
      try {
        this.sender.stop();
      } catch {
        /* ignore */
      }
      this.sender = null;
    }
  }

  private pipeSenderStream(readable: Readable, token: number): void {
    if (!this.sender || token !== this.startToken) return;
    const flow = new FlowBuffer(
      (chunk) => {
        if (!this.sender || token !== this.startToken) return;
        this.sender.sendPcm(chunk);
      },
      (err) =>
        this.log.warn('airplay sender stream error', {
          message: err instanceof Error ? err.message : String(err),
        }),
    );
    this.flowBuffers.add(flow);
    const readyTimer = setTimeout(() => flow.ready(), 150);
    const cleanup = () => {
      clearTimeout(readyTimer);
      this.flowBuffers.delete(flow);
    };
    const source = readable;
    source.on('data', (chunk: Buffer) => {
      if (!chunk?.length) return;
      flow.push(chunk);
    });
    source.on('end', () => {
      flow.flush();
      cleanup();
    });
    source.on('error', (err) => {
      this.log.warn('airplay sender source error', {
        message: err instanceof Error ? err.message : String(err),
      });
      flow.flush();
      cleanup();
    });
  }

  private async pipeSenderFromUrl(url: string, token: number, signal: AbortSignal): Promise<void> {
    const resolved = this.resolveUrl(url);
    const response = await fetch(resolved, { signal });
    if (!response.ok || !response.body) {
      throw new Error(`fetch failed status:${response.status}`);
    }
    const readable = Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
    this.pipeSenderStream(readable, token);
  }

  // --- Utilities -----------------------------------------------------------

  private async resolveDeviceConfig(): Promise<ResolvedAirplayConfig> {
    if (this.resolvedConfig) {
      return this.resolvedConfig;
    }

    if (this.config.forceAp2 === true && !this.config.disableDiscovery) {
      const target = this.config.host.trim().toLowerCase();
      try {
        const devices = await discoverAirplayDevices(2000);
        const matches = devices.filter((device) => {
          return [device.host, device.address, device.name]
            .filter((value): value is string => Boolean(value))
            .some((value) => value.toLowerCase() === target);
        });
        const validated = resolveConfiguredAirplayConfig({ port: this.config.port, forceAp2: this.config.forceAp2 }, matches);
        if (validated) {
          this.resolvedConfig = validated;
          this.log.info('airplay discovery validated configured AP2 mode', {
            host: this.config.host,
            resolvedPort: this.resolvedConfig.port,
            forceAp2: this.resolvedConfig.forceAp2,
          });
          return this.resolvedConfig;
        }
      } catch (err) {
        this.log.warn('airplay discovery failed', {
          host: this.config.host,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (this.config.disableDiscovery || this.config.port || this.config.forceAp2 !== undefined) {
      this.resolvedConfig = {
        port: this.config.port,
        forceAp2: this.config.forceAp2,
      };
      return this.resolvedConfig;
    }

    const target = this.config.host.trim().toLowerCase();
    try {
      const devices = await discoverAirplayDevices(2000);
      const matches = devices.filter((device) => {
        return [device.host, device.address, device.name]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLowerCase() === target);
      });
      if (matches.length > 0) {
        const preferred = resolveDiscoveredAirplayConfig(matches);
        this.resolvedConfig = preferred;
        this.log.info('airplay discovery resolved device', {
          host: this.config.host,
          resolvedPort: this.resolvedConfig.port,
          forceAp2: this.resolvedConfig.forceAp2,
        });
        this.log.debug('airplay discovery txt', {
          host: this.config.host,
          txt: preferred.txt,
        });
        return this.resolvedConfig;
      }
    } catch (err) {
      this.log.warn('airplay discovery failed', {
        host: this.config.host,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    this.resolvedConfig = {
      port: this.config.port,
      forceAp2: this.config.forceAp2,
    };
    return this.resolvedConfig;
  }

  private clearAutoResolvedConfig(reason: string): void {
    if (this.config.disableDiscovery || this.config.port || this.config.forceAp2 !== undefined) {
      return;
    }
    if (!this.resolvedConfig) {
      return;
    }
    this.log.info('clearing cached airplay discovery result', {
      host: this.config.host,
      reason,
      resolvedPort: this.resolvedConfig.port,
      forceAp2: this.resolvedConfig.forceAp2,
    });
    this.resolvedConfig = undefined;
  }

  private resolveUrl(url: string): string {
    const fallbackHost = this.pickLocalAddress();
    const fallbackPort = 7090;
    const isLoopback = (h?: string) => !h || h === 'localhost' || h === '::1' || h.startsWith('127.');

    try {
      const resolved = url.startsWith('http')
        ? new URL(url)
        : new URL(url.startsWith('/') ? url : `/${url}`, `http://${fallbackHost}:${fallbackPort}`);

      if (isLoopback(resolved.hostname)) {
        resolved.hostname = fallbackHost;
        if (!resolved.port) resolved.port = String(fallbackPort);
      } else if (!resolved.port) {
        resolved.port = String(fallbackPort);
      }

      return resolved.toString();
    } catch {
      return url;
    }
  }

  private pickLocalAddress(): string {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal && net.address) {
          return net.address;
        }
      }
    }
    return '0.0.0.0';
  }

  public flush(): void {
    for (const flow of this.flowBuffers) {
      flow.flush();
    }
  }
}

export function resolveDiscoveredAirplayConfig(matches: AirplayDeviceDescriptor[]): ResolvedAirplayConfig {
  const raop = matches.find((device) => device.protocol === 'raop');
  if (raop) {
    return {
      port: raop.port,
      forceAp2: false,
      txt: txtRecordToArray(raop.txt),
    };
  }

  const airplay = matches.find((device) => device.protocol === 'airplay') ?? matches[0];
  if (!airplay) {
    return {};
  }
  const txt = txtRecordToArray(airplay.txt);
  const airplay2 = airplayTxtSuggestsAirPlay2(airplay.txt);
  return {
    port: airplay2 ? airplay.port : undefined,
    forceAp2: airplay2,
    txt,
  };
}

export function resolveConfiguredAirplayConfig(
  config: { port?: number; forceAp2?: boolean },
  matches: AirplayDeviceDescriptor[],
): ResolvedAirplayConfig | undefined {
  if (config.forceAp2 !== true || matches.length === 0) {
    return undefined;
  }

  const airplay2 = matches.find((device) => device.protocol === 'airplay' && airplayTxtSuggestsAirPlay2(device.txt));
  if (airplay2) {
    return {
      port: config.port ?? airplay2.port,
      forceAp2: true,
      txt: txtRecordToArray(airplay2.txt),
    };
  }

  const raop = matches.find((device) => device.protocol === 'raop');
  if (raop) {
    return {
      port: raop.port,
      forceAp2: false,
      txt: txtRecordToArray(raop.txt),
    };
  }

  const airplay = matches.find((device) => device.protocol === 'airplay');
  if (airplay) {
    return {
      port: null,
      forceAp2: false,
      txt: txtRecordToArray(airplay.txt),
    };
  }

  return undefined;
}

function txtRecordToArray(txt: Record<string, unknown> | undefined): string[] | undefined {
  if (!txt) {
    return undefined;
  }
  return Object.entries(txt)
    .map(([key, value]) => {
      if (value === true || value === null || value === undefined) {
        return key;
      }
      return `${key}=${String(value)}`;
    })
    .filter((entry) => entry.length > 0);
}

class FlowBuffer {
  private readonly buffer: Buffer[] = [];
  private bytes = 0;
  private readyFlag = false;
  constructor(
    private readonly write: (chunk: Buffer) => void,
    private readonly onError: (err: unknown) => void,
    private readonly flushSize = 1024 * 128,
    private readonly maxSize = 1024 * 512,
  ) {}

  public push(chunk: Buffer): void {
    if (this.readyFlag) {
      this.safeWrite(chunk);
      return;
    }
    this.buffer.push(chunk);
    this.bytes += chunk.length;
    if (this.bytes >= this.flushSize) {
      this.flush();
    }
    if (this.bytes > this.maxSize) {
      this.buffer.length = 0;
      this.bytes = 0;
    }
  }

  public ready(): void {
    if (this.readyFlag) return;
    this.readyFlag = true;
    this.flush();
  }

  public reset(keepReady = false): void {
    this.buffer.length = 0;
    this.bytes = 0;
    if (!keepReady) {
      this.readyFlag = false;
    }
  }

  public flush(): void {
    if (!this.buffer.length) return;
    const chunks = this.buffer.splice(0);
    this.bytes = 0;
    for (const chunk of chunks) {
      this.safeWrite(chunk);
    }
  }

  private safeWrite(chunk: Buffer): void {
    try {
      this.write(chunk);
    } catch (err) {
      this.onError(err);
    }
  }
}
