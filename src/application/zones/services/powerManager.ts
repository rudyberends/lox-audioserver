import dgram from 'node:dgram';
import { execFile } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type {
  ZoneConfig,
  ZoneCrelayPowerConfig,
  ZoneGpioPowerConfig,
  ZonePowerManagerConfig,
  ZoneUdpPowerConfig,
  ZoneUrlPowerConfig,
} from '@/domain/config/types';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import type { ComponentLogger } from '@/shared/logging/logger';

const execFileAsync = promisify(execFile);

type PowerSignal = 0 | 1;
type TimerHandle = ReturnType<typeof setTimeout>;

type NormalizedZonePowerConfig = {
  onDelayMs: number;
  offDelayMs: number;
  actions: NormalizedPowerAction[];
};

type NormalizedPowerAction =
  | { type: 'gpio'; config: NormalizedGpioConfig }
  | { type: 'url'; config: NormalizedUrlConfig }
  | { type: 'udp'; config: NormalizedUdpConfig }
  | { type: 'crelay'; config: NormalizedCrelayConfig };

type NormalizedGpioConfig = {
  pin: number;
  activeHigh: boolean;
  driver: 'sysfs' | 'gpioset';
  basePath: string;
  chip: string;
  gpiosetPath: string;
};

type NormalizedUrlConfig = {
  onUrl: string;
  offUrl: string;
  curlPath: string;
  insecure: boolean;
};

type NormalizedUdpConfig = {
  host: string;
  port: number;
  onPayload: string;
  offPayload: string;
};

type NormalizedCrelayConfig = {
  serial: string;
  relay: string;
  binaryPath: string;
};

type ZoneRuntime = {
  desiredSignal: PowerSignal;
  currentSignal: PowerSignal | null;
  onTimer: TimerHandle | null;
  offTimer: TimerHandle | null;
  inflight: Promise<void>;
  config: NormalizedZonePowerConfig;
};

export interface PowerManagerExecutor {
  execute(action: NormalizedPowerAction, signal: PowerSignal): Promise<void>;
}

export class PowerManager {
  private readonly zones = new Map<number, ZoneRuntime>();
  private readonly invalidConfigWarned = new Set<number>();

  constructor(
    private readonly log: ComponentLogger,
    private readonly executor: PowerManagerExecutor = new SystemPowerManagerExecutor(),
  ) {}

  public onStatePatch(
    zoneId: number,
    zoneConfig: ZoneConfig,
    patch: Partial<LoxoneZoneState>,
    nextState: LoxoneZoneState,
  ): void {
    if (!('mode' in patch)) {
      return;
    }
    const normalized = normalizePowerManagerConfig(zoneConfig.powerManager ?? null);
    if (!normalized) {
      const raw = zoneConfig.powerManager ?? null;
      if (raw && raw.enabled !== false && !this.invalidConfigWarned.has(zoneId)) {
        this.invalidConfigWarned.add(zoneId);
        this.log.warn('zone power manager disabled due to invalid config', {
          zoneId,
          powerManager: raw,
        });
      }
      this.clearZone(zoneId);
      return;
    }
    this.invalidConfigWarned.delete(zoneId);
    const desired: PowerSignal = nextState.mode === 'play' ? 1 : 0;
    this.setDesired(zoneId, normalized, desired);
  }

  public clearZone(zoneId: number): void {
    const runtime = this.zones.get(zoneId);
    if (!runtime) {
      return;
    }
    if (runtime.onTimer) {
      clearTimeout(runtime.onTimer);
      runtime.onTimer = null;
    }
    if (runtime.offTimer) {
      clearTimeout(runtime.offTimer);
      runtime.offTimer = null;
    }
    this.zones.delete(zoneId);
    this.invalidConfigWarned.delete(zoneId);
  }

  public clearAll(): void {
    for (const zoneId of this.zones.keys()) {
      this.clearZone(zoneId);
    }
  }

  private setDesired(
    zoneId: number,
    config: NormalizedZonePowerConfig,
    desiredSignal: PowerSignal,
  ): void {
    const runtime = this.ensureRuntime(zoneId, config);
    runtime.config = config;
    runtime.desiredSignal = desiredSignal;
    if (desiredSignal === 1) {
      if (runtime.offTimer) {
        clearTimeout(runtime.offTimer);
        runtime.offTimer = null;
      }
      this.scheduleSignal(zoneId, runtime, 1, config.onDelayMs, 'onTimer');
      return;
    }
    if (runtime.onTimer) {
      clearTimeout(runtime.onTimer);
      runtime.onTimer = null;
    }
    this.scheduleSignal(zoneId, runtime, 0, config.offDelayMs, 'offTimer');
  }

  private ensureRuntime(zoneId: number, config: NormalizedZonePowerConfig): ZoneRuntime {
    const existing = this.zones.get(zoneId);
    if (existing) {
      return existing;
    }
    const runtime: ZoneRuntime = {
      desiredSignal: 0,
      currentSignal: null,
      onTimer: null,
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
    timerKey: 'onTimer' | 'offTimer',
  ): void {
    if (runtime[timerKey]) {
      clearTimeout(runtime[timerKey]!);
      runtime[timerKey] = null;
    }
    if (runtime.currentSignal === signal) {
      return;
    }
    if (delayMs <= 0) {
      this.applySignal(zoneId, signal);
      return;
    }
    runtime[timerKey] = setTimeout(() => {
      runtime[timerKey] = null;
      this.applySignal(zoneId, signal);
    }, delayMs);
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
          return;
        }
        for (const action of fresh.config.actions) {
          try {
            await this.executor.execute(action, signal);
          } catch (error: unknown) {
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
        if (active && active.desiredSignal === signal) {
          active.currentSignal = signal;
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('zone power manager signal failed', { zoneId, signal, message });
      });
  }
}

class SystemPowerManagerExecutor implements PowerManagerExecutor {
  private readonly exportedPins = new Set<number>();

  public async execute(action: NormalizedPowerAction, signal: PowerSignal): Promise<void> {
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
    if (config.driver === 'gpioset') {
      const value = resolvePhysicalValue(signal, config.activeHigh);
      const chipRef = config.chip.includes('/') ? config.chip : `/dev/${config.chip}`;
      await execFileAsync(config.gpiosetPath, [chipRef, `${config.pin}=${value}`]);
      return;
    }
    const gpioDir = `${config.basePath}/gpio${config.pin}`;
    if (!this.exportedPins.has(config.pin)) {
      const exists = await pathExists(gpioDir);
      if (!exists) {
        await writeFile(`${config.basePath}/export`, String(config.pin));
      }
      await writeFile(`${gpioDir}/direction`, 'out');
      this.exportedPins.add(config.pin);
    }
    const value = resolvePhysicalValue(signal, config.activeHigh);
    await writeFile(`${gpioDir}/value`, String(value));
  }

  private async callUrl(config: NormalizedUrlConfig, signal: PowerSignal): Promise<void> {
    const target = signal === 1 ? config.onUrl : config.offUrl;
    if (!target) {
      return;
    }
    const args = ['-s'];
    if (config.insecure) {
      args.push('--insecure');
    }
    args.push(target);
    await execFileAsync(config.curlPath, args);
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
    await execFileAsync(config.binaryPath, ['-s', config.serial, config.relay, state]);
  }
}

function normalizePowerManagerConfig(raw: ZonePowerManagerConfig | null): NormalizedZonePowerConfig | null {
  if (!raw || raw.enabled === false) {
    return null;
  }
  const actions: NormalizedPowerAction[] = [];
  const gpio = normalizeGpio(raw.gpio ?? null);
  if (gpio) {
    actions.push({ type: 'gpio', config: gpio });
  }
  const url = normalizeUrl(raw.url ?? null);
  if (url) {
    actions.push({ type: 'url', config: url });
  }
  const udp = normalizeUdp(raw.udp ?? null);
  if (udp) {
    actions.push({ type: 'udp', config: udp });
  }
  const crelay = normalizeCrelay(raw.crelay ?? null);
  if (crelay) {
    actions.push({ type: 'crelay', config: crelay });
  }
  if (actions.length < 1) {
    return null;
  }
  return {
    onDelayMs: toDelay(raw.onDelayMs),
    offDelayMs: toDelay(raw.offDelayMs),
    actions,
  };
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
    driver: raw.driver === 'gpioset' ? 'gpioset' : 'sysfs',
    basePath: raw.basePath?.trim() || '/sys/class/gpio',
    chip: raw.chip?.trim() || 'gpiochip0',
    gpiosetPath: raw.gpiosetPath?.trim() || 'gpioset',
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
    curlPath: raw.curlPath?.trim() || 'curl',
    insecure: raw.insecure !== false,
  };
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
  const serial = raw.serial?.trim() || '';
  const relay = raw.relay?.trim() || '';
  if (!serial || !relay) {
    return null;
  }
  return {
    serial,
    relay,
    binaryPath: raw.binaryPath?.trim() || '/usr/local/bin/crelay',
  };
}

function toDelay(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

function resolvePhysicalValue(signal: PowerSignal, activeHigh: boolean): 0 | 1 {
  if (signal === 1) {
    return activeHigh ? 1 : 0;
  }
  return activeHigh ? 0 : 1;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
