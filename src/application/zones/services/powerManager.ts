import dgram from 'node:dgram';
import { execFile } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { promisify } from 'node:util';
import type {
  ZoneConfig,
  ZoneCrelayPowerConfig,
  ZoneGpioPowerConfig,
  ZonePowerManagerConfig,
  ZoneUdpPowerConfig,
  ZoneUrlPowerConfig,
} from '@/domain/config/types';
import type { ZoneState } from '@/domain/zones/zoneState';
import type { ComponentLogger } from '@/shared/logging/logger';

const execFileAsync = promisify(execFile);
const GPIOSET_BIN = 'gpioset';
const DEFAULT_OFF_DELAY_MS = 300_000;

export type PowerSignal = 0 | 1;
type TimerHandle = ReturnType<typeof setTimeout>;

export type NormalizedPowerConfig = {
  activeModes: ReadonlySet<'play' | 'pause'>;
  offDelayMs: number;
  actions: NormalizedPowerAction[];
};

export type NormalizedPowerAction =
  | { type: 'gpio'; config: NormalizedGpioConfig }
  | { type: 'url'; config: NormalizedUrlConfig }
  | { type: 'udp'; config: NormalizedUdpConfig }
  | { type: 'crelay'; config: NormalizedCrelayConfig };

export type NormalizedGpioConfig = {
  pin: number;
  activeHigh: boolean;
  chip: string;
  gpiosetPath: string;
};

export type NormalizedUrlConfig = {
  onUrl: string;
  offUrl: string;
};

export type NormalizedUdpConfig = {
  host: string;
  port: number;
  onPayload: string;
  offPayload: string;
};

export type NormalizedCrelayConfig = {
  serial: string | null;
  relay: string;
  binaryPath: string;
};

type ZoneRuntime = {
  desiredSignal: PowerSignal;
  currentSignal: PowerSignal | null;
  offTimer: TimerHandle | null;
  inflight: Promise<void>;
  config: NormalizedPowerConfig;
};

export interface PowerManagerExecutor {
  execute(action: NormalizedPowerAction, signal: PowerSignal): Promise<void>;
}

export class PowerManager {
  private readonly zones = new Map<number, ZoneRuntime>();

  constructor(
    private readonly log: ComponentLogger,
    private readonly executor: PowerManagerExecutor = new SystemPowerManagerExecutor(),
    private readonly onSignalChanged?: (zoneId: number, signal: PowerSignal) => void,
  ) {}

  public onStatePatch(
    zoneId: number,
    zoneConfig: ZoneConfig,
    patch: Partial<ZoneState>,
    nextState: ZoneState,
  ): void {
    if (!('mode' in patch)) {
      return;
    }
    const normalized = normalizePowerManagerConfig(zoneConfig.powerManager ?? null);
    const desired: PowerSignal = isPowerOnMode(normalized.activeModes, nextState.mode) ? 1 : 0;
    this.log.debug('zone power manager state update', {
      zoneId,
      zoneName: zoneConfig.name,
      mode: nextState.mode,
      desiredSignal: desired,
      actions: normalized.actions.map((action) => action.type),
      offDelayMs: normalized.offDelayMs,
    });
    this.setDesired(zoneId, normalized, desired);
  }

  public clearZone(zoneId: number): void {
    const runtime = this.zones.get(zoneId);
    if (!runtime) {
      return;
    }
    if (runtime.offTimer) {
      clearTimeout(runtime.offTimer);
      runtime.offTimer = null;
    }
    this.zones.delete(zoneId);
  }

  public clearAll(): void {
    for (const zoneId of this.zones.keys()) {
      this.clearZone(zoneId);
    }
  }

  public isSignalOn(zoneId: number): boolean {
    return this.zones.get(zoneId)?.currentSignal === 1;
  }

  private setDesired(
    zoneId: number,
    config: NormalizedPowerConfig,
    desiredSignal: PowerSignal,
  ): void {
    const runtime = this.ensureRuntime(zoneId, config);
    const previousDesired = runtime.desiredSignal;
    runtime.config = config;
    runtime.desiredSignal = desiredSignal;
    if (previousDesired !== desiredSignal) {
      this.log.debug('zone power manager desired signal changed', {
        zoneId,
        previousDesired,
        desiredSignal,
      });
    }
    if (desiredSignal === 1) {
      // Power on immediately; amp warm-up is compensated via playbackPreDelayMs
      // (silence prepended to the audio), not by delaying the relay.
      if (runtime.offTimer) {
        clearTimeout(runtime.offTimer);
        runtime.offTimer = null;
        this.log.spam('zone power manager cancelled pending off timer', { zoneId });
      }
      this.scheduleSignal(zoneId, runtime, 1, 0);
      return;
    }
    this.scheduleSignal(zoneId, runtime, 0, config.offDelayMs);
  }

  private ensureRuntime(zoneId: number, config: NormalizedPowerConfig): ZoneRuntime {
    const existing = this.zones.get(zoneId);
    if (existing) {
      return existing;
    }
    const runtime: ZoneRuntime = {
      desiredSignal: 0,
      currentSignal: null,
      offTimer: null,
      inflight: Promise.resolve(),
      config,
    };
    this.zones.set(zoneId, runtime);
    return runtime;
  }

  private scheduleSignal(
    zoneId: number,
    runtime: ZoneRuntime,
    signal: PowerSignal,
    delayMs: number,
  ): void {
    if (runtime.offTimer) {
      clearTimeout(runtime.offTimer);
      runtime.offTimer = null;
    }
    if (runtime.currentSignal === signal) {
      this.log.spam('zone power manager skipped schedule; signal already applied', {
        zoneId,
        signal,
      });
      return;
    }
    if (delayMs <= 0) {
      this.log.debug('zone power manager applying signal immediately', {
        zoneId,
        signal,
      });
      this.applySignal(zoneId, signal);
      return;
    }
    this.log.debug('zone power manager scheduled signal', {
      zoneId,
      signal,
      delayMs,
    });
    runtime.offTimer = setTimeout(() => {
      runtime.offTimer = null;
      this.applySignal(zoneId, signal);
    }, delayMs);
    runtime.offTimer?.unref?.();
  }

  private applySignal(zoneId: number, signal: PowerSignal): void {
    const runtime = this.zones.get(zoneId);
    if (!runtime) {
      return;
    }
    runtime.inflight = runtime.inflight
      .then(async () => {
        const fresh = this.zones.get(zoneId);
        if (!fresh || fresh.desiredSignal !== signal || fresh.currentSignal === signal) {
          this.log.spam('zone power manager skipped apply', {
            zoneId,
            signal,
            hasRuntime: Boolean(fresh),
            desiredSignal: fresh?.desiredSignal,
            currentSignal: fresh?.currentSignal,
          });
          return;
        }
        this.log.info('zone power manager applying signal', {
          zoneId,
          signal,
          actions: fresh.config.actions.map((action) => action.type),
        });
        let allSucceeded = true;
        for (const action of fresh.config.actions) {
          try {
            await this.executor.execute(action, signal);
          } catch (error: unknown) {
            allSucceeded = false;
            const message = error instanceof Error ? error.message : String(error);
            this.log.warn('zone power manager action failed', {
              zoneId,
              action: action.type,
              signal,
              message,
            });
          }
        }
        const active = this.zones.get(zoneId);
        // Only record the signal as applied when every action succeeded. Latching
        // currentSignal after a failed switch would make a stuck relay look settled,
        // and the desired/current equality guards would never retry it (#293).
        if (active && active.desiredSignal === signal && allSucceeded) {
          const previous = active.currentSignal;
          active.currentSignal = signal;
          if (previous !== signal) {
            this.log.info('zone power manager signal applied', {
              zoneId,
              previousSignal: previous,
              signal,
            });
            this.onSignalChanged?.(zoneId, signal);
          }
        } else if (active && !allSucceeded) {
          this.log.debug('zone power manager leaving signal unconfirmed after failure', {
            zoneId,
            signal,
            currentSignal: active.currentSignal,
          });
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('zone power manager signal failed', { zoneId, signal, message });
      });
  }
}

export type PowerCommandRunner = (file: string, args: string[]) => Promise<unknown>;

export class SystemPowerManagerExecutor implements PowerManagerExecutor {
  // Serialize execution per physical device. A crelay/USB-HID relay card can only be opened
  // by one process at a time; when an alert hits zones on multiple amps the managers would
  // otherwise spawn concurrent `crelay` processes against the same card and all but one fail
  // with "unable to open HID API device" (#293). One executor instance is shared across the
  // per-zone and shared-group managers, so this chain serializes access across both of them.
  private readonly deviceChains = new Map<string, Promise<void>>();

  // Injectable command runner (defaults to execFile); overridable so the crelay retry path
  // can be unit-tested without spawning a real subprocess.
  constructor(private readonly runCommand: PowerCommandRunner = (file, args) => execFileAsync(file, args)) {}

  public execute(action: NormalizedPowerAction, signal: PowerSignal): Promise<void> {
    const key = deviceKey(action);
    const previous = this.deviceChains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.run(action, signal));
    this.deviceChains.set(key, next.catch(() => undefined));
    return next;
  }

  private async run(action: NormalizedPowerAction, signal: PowerSignal): Promise<void> {
    if (action.type === 'gpio') {
      await this.writeGpio(action.config, signal);
      return;
    }
    if (action.type === 'url') {
      await this.callUrl(action.config, signal);
      return;
    }
    if (action.type === 'udp') {
      await this.sendUdp(action.config, signal);
      return;
    }
    await this.callCrelay(action.config, signal);
  }

  private async writeGpio(config: NormalizedGpioConfig, signal: PowerSignal): Promise<void> {
    const value = resolvePhysicalValue(signal, config.activeHigh);
    const chipRef = config.chip.includes('/') ? config.chip : `/dev/${config.chip}`;
    await this.runCommand(config.gpiosetPath, [chipRef, `${config.pin}=${value}`]);
  }

  private async callUrl(config: NormalizedUrlConfig, signal: PowerSignal): Promise<void> {
    const target = signal === 1 ? config.onUrl : config.offUrl;
    if (!target) {
      return;
    }
    await requestUrl(target);
  }

  private async sendUdp(config: NormalizedUdpConfig, signal: PowerSignal): Promise<void> {
    const payload = signal === 1 ? config.onPayload : config.offPayload;
    if (!payload) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      const data = Buffer.from(payload);
      socket.send(data, config.port, config.host, (error) => {
        socket.close();
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async callCrelay(config: NormalizedCrelayConfig, signal: PowerSignal): Promise<void> {
    const state = signal === 1 ? 'ON' : 'OFF';
    const args = config.serial ? ['-s', config.serial, config.relay, state] : [config.relay, state];
    // Even with per-device serialization the HID handle can briefly be unavailable (the
    // previous open is still being torn down, or another process touched the card), so retry
    // the transient "unable to open HID API device" failure a couple of times before giving up.
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.runCommand(config.binaryPath, args);
        return;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const transient = /unable to open HID API device|resource busy|device or resource busy/i.test(message);
        if (attempt < maxAttempts && transient) {
          await sleep(80 * attempt);
          continue;
        }
        throw error;
      }
    }
  }
}

function deviceKey(action: NormalizedPowerAction): string {
  switch (action.type) {
    case 'crelay':
      // Channels on the same card share a single HID device, so key by the card
      // (binary + serial) rather than the relay channel to serialize all channels.
      return `crelay:${action.config.binaryPath}:${action.config.serial ?? ''}`;
    case 'gpio':
      return `gpio:${action.config.chip}`;
    case 'url':
      return `url:${action.config.onUrl || action.config.offUrl}`;
    case 'udp':
      return `udp:${action.config.host}:${action.config.port}`;
  }
}

function sleep(ms: number): Promise<void> {
  // Not unref'd: this short retry backoff must keep the event loop alive until it resolves,
  // unlike the long-lived OFF timers which are unref'd so they never block shutdown.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function normalizePowerManagerConfig(raw: ZonePowerManagerConfig | null): NormalizedPowerConfig {
  const config = raw ?? {};
  const actions: NormalizedPowerAction[] = [];
  const gpio = normalizeGpio(config.gpio ?? null);
  if (gpio) {
    actions.push({ type: 'gpio', config: gpio });
  }
  const url = normalizeUrl(config.url ?? null);
  if (url) {
    actions.push({ type: 'url', config: url });
  }
  const udp = normalizeUdp(config.udp ?? null);
  if (udp) {
    actions.push({ type: 'udp', config: udp });
  }
  const crelay = normalizeCrelay(config.crelay ?? null);
  if (crelay) {
    actions.push({ type: 'crelay', config: crelay });
  }
  return {
    activeModes: normalizeActiveModes(config.activeModes),
    offDelayMs:
      config.offDelayEnabled === false ? 0 : toDelay(config.offDelayMs, DEFAULT_OFF_DELAY_MS),
    actions,
  };
}

function normalizeActiveModes(raw: ZonePowerManagerConfig['activeModes']): ReadonlySet<'play' | 'pause'> {
  const modes = new Set<'play' | 'pause'>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry === 'play' || entry === 'pause') {
        modes.add(entry);
      }
    }
  }
  if (modes.size < 1) {
    modes.add('play');
  }
  return modes;
}

export function isPowerOnMode(
  activeModes: ReadonlySet<'play' | 'pause'>,
  mode: ZoneState['mode'],
): boolean {
  return mode === 'play' || (mode === 'pause' && activeModes.has('pause'));
}

function normalizeGpio(raw: ZoneGpioPowerConfig | null): NormalizedGpioConfig | null {
  if (!raw || raw.enabled === false) {
    return null;
  }
  if (!Number.isInteger(raw.pin) || (raw.pin as number) < 0) {
    return null;
  }
  return {
    pin: raw.pin as number,
    activeHigh: raw.activeHigh !== false,
    chip: raw.chip?.trim() || 'gpiochip0',
    gpiosetPath: raw.gpiosetPath?.trim() || GPIOSET_BIN,
  };
}

function normalizeUrl(raw: ZoneUrlPowerConfig | null): NormalizedUrlConfig | null {
  if (!raw || raw.enabled === false) {
    return null;
  }
  const onUrl = raw.onUrl?.trim() || '';
  const offUrl = raw.offUrl?.trim() || '';
  if (!onUrl && !offUrl) {
    return null;
  }
  return {
    onUrl,
    offUrl,
  };
}

async function requestUrl(rawTarget: string, redirects = 0): Promise<void> {
  if (redirects > 5) {
    throw new Error('too many redirects');
  }
  let target: URL;
  try {
    target = new URL(rawTarget);
  } catch {
    throw new Error('invalid url');
  }
  const isHttps = target.protocol === 'https:';
  const client = isHttps ? httpsRequest : httpRequest;
  const authorization = basicAuthHeader(target);
  await new Promise<void>((resolve, reject) => {
    const req = client(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        timeout: 8000,
        rejectUnauthorized: isHttps ? false : undefined,
        headers: {
          accept: '*/*',
          'user-agent': 'sonn-core-power-manager',
          ...(authorization ? { authorization } : {}),
        },
      },
      (res) => {
        const code = typeof res.statusCode === 'number' ? res.statusCode : 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          const location = new URL(res.headers.location, target).toString();
          res.resume();
          resolve(requestUrl(location, redirects + 1));
          return;
        }
        res.resume();
        if (code >= 200 && code < 400) {
          resolve();
          return;
        }
        reject(new Error(`http ${code || 'request failed'}`));
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end();
  });
}

function basicAuthHeader(target: URL): string | null {
  if (!target.username && !target.password) {
    return null;
  }
  const username = decodeUrlCredential(target.username);
  const password = decodeUrlCredential(target.password);
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function decodeUrlCredential(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeUdp(raw: ZoneUdpPowerConfig | null): NormalizedUdpConfig | null {
  if (!raw || raw.enabled === false) {
    return null;
  }
  const host = raw.host?.trim() || '';
  const port = raw.port;
  const onPayload = raw.onPayload ?? '';
  const offPayload = raw.offPayload ?? '';
  if (!host || !Number.isInteger(port) || (port as number) <= 0 || (port as number) > 65535) {
    return null;
  }
  if (!onPayload && !offPayload) {
    return null;
  }
  return {
    host,
    port: port as number,
    onPayload,
    offPayload,
  };
}

function normalizeCrelay(raw: ZoneCrelayPowerConfig | null): NormalizedCrelayConfig | null {
  if (!raw || raw.enabled === false) {
    return null;
  }
  const serial = raw.serial?.trim() || null;
  const relay = raw.relay?.trim() || '';
  if (!relay) {
    return null;
  }
  return {
    serial,
    relay,
    binaryPath: raw.binaryPath?.trim() || '/usr/local/bin/crelay',
  };
}

function toDelay(value: number | undefined, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.round(value));
}

function resolvePhysicalValue(signal: PowerSignal, activeHigh: boolean): 0 | 1 {
  if (signal === 1) {
    return activeHigh ? 1 : 0;
  }
  return activeHigh ? 0 : 1;
}
