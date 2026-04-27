import path from 'node:path';
import type { StoragePort } from '@/ports/StoragePort';
import { defaultMacId } from '@/shared/utils/mac';
import { defaultLocalIp } from '@/shared/utils/net';
import type {
  AudioServerConfig,
  LoxBerryTtsProviderConfig,
  RawAudioConfig,
  TtsProviderConfig,
  ZoneConfig,
} from '@/domain/config/types';

const CONFIG_PATH = path.resolve(process.cwd(), 'data', 'config.json');

/**
 * Minimal configuration store backed by a JSON file on disk.
 */
export class ConfigRepository {
  private config: AudioServerConfig | null = null;
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(private readonly storage: StoragePort) {}

  public async load(): Promise<AudioServerConfig> {
    const fallback = defaultConfig();
    const loaded = await this.storage.readJson<AudioServerConfig | null>(
      CONFIG_PATH,
      fallback,
      { writeIfMissing: true },
    );
    this.config = loaded || fallback;
    if (!loaded) {
      await this.storage.writeJson(CONFIG_PATH, fallback);
    }
    const systemMigrated = normalizeSystem(this.config);
    const contentMigrated = normalizeContent(this.config);
    normalizeInputs(this.config);
    normalizeGroups(this.config);
    const outputMigrated = normalizeZones(this.config);
    if (systemMigrated || contentMigrated || outputMigrated) {
      await this.storage.writeJson(CONFIG_PATH, this.config);
    }
    return this.config;
  }

  public get(): AudioServerConfig {
    if (!this.config) {
      throw new Error('configuration not loaded');
    }
    return this.config;
  }

  public ensureInputs(): void {
    if (!this.config) {
      throw new Error('configuration not loaded');
    }
    normalizeSystem(this.config);
    normalizeInputs(this.config);
    normalizeGroups(this.config);
    normalizeZones(this.config);
  }

  public getSystem(): AudioServerConfig['system'] {
    return this.get().system;
  }

  public getRawAudioConfig(): RawAudioConfig {
    return this.get().rawAudioConfig;
  }

  public async save(): Promise<void> {
    await this.storage.writeJson(CONFIG_PATH, this.get());
  }

  public async patch(
    mutator: (config: AudioServerConfig) => void | Promise<void>,
  ): Promise<AudioServerConfig> {
    return this.withUpdateLock(async () => {
      if (!this.config) {
        await this.load();
      }

      await mutator(this.config!);
      normalizeSystem(this.config!);
      normalizeContent(this.config!);
      normalizeInputs(this.config!);
      normalizeGroups(this.config!);
      normalizeZones(this.config!);
      await this.save();
      return this.config!;
    });
  }

  public async update(
    mutator: (config: AudioServerConfig) => void | Promise<void>,
  ): Promise<AudioServerConfig> {
    return this.patch(async (cfg) => {
      const before = serializeConfig(cfg);
      await mutator(cfg);
      normalizeSystem(cfg);
      normalizeContent(cfg);
      normalizeInputs(cfg);
      normalizeGroups(cfg);
      normalizeZones(cfg);
      const after = serializeConfig(cfg);
      if (before !== after) {
        cfg.updatedAt = new Date().toISOString();
      }
    });
  }

  private async withUpdateLock<T>(work: () => Promise<T>): Promise<T> {
    let release: () => void = () => {};
    const prev = this.updateQueue;
    this.updateQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

export function createConfigRepository(storage: StoragePort): ConfigRepository {
  return new ConfigRepository(storage);
}

function serializeConfig(config: AudioServerConfig): string {
  return JSON.stringify(config, (key, value) =>
    key === 'updatedAt' ? undefined : value,
  );
}

function defaultConfig(): AudioServerConfig {
  return {
    system: {
      miniserver: { ip: '', serial: '', port: 80, protocol: 'http' },
      audioserver: {
        ip: defaultLocalIp(),
        name: 'Unconfigured',
        uuid: '',
        macId: defaultMacId(),
        paired: false,
        authEnabled: true,
        extensions: [],
        slimprotoPort: 3483,
        slimprotoCliPort: 9090,
        slimprotoJsonPort: 9000,
      },
      logging: {
        consoleLevel: 'none',
        fileLevel: 'none',
      },
      adminHttp: { enabled: true },
    },
    content: {
      radio: {
        tuneInUsername: '',
      },
      spotify: {
        clientId: '',
        accounts: [],
        bridges: [],
      },
      tts: {
        provider: { type: 'internal' },
        fallbackToInternal: true,
      },
    },
    inputs: {
      airplay: {
        enabled: true,
      },
      spotify: {
        enabled: true,
      },
      bluetooth: {
        enabled: false,
      },
      lineIn: {
        inputs: [],
        bridges: [],
      },
    },
    groups: {
      mixedGroupEnabled: false,
      powerGroups: [],
    },
    zones: [],
    rawAudioConfig: {
      raw: null,
      rawString: null,
      crc32: null,
    },
    updatedAt: new Date().toISOString(),
  };
}

function normalizeContent(config: AudioServerConfig): boolean {
  let changed = false;
  const defaults = defaultConfig().content;
  if (!config.content) {
    config.content = defaults;
    return true;
  }
  if (!config.content.radio) {
    config.content.radio = defaults.radio;
    changed = true;
  }
  if (!config.content.spotify) {
    config.content.spotify = defaults.spotify;
    changed = true;
  } else {
    if (!Array.isArray(config.content.spotify.accounts)) {
      config.content.spotify.accounts = [];
      changed = true;
    }
    if (!Array.isArray(config.content.spotify.bridges)) {
      config.content.spotify.bridges = [];
      changed = true;
    }
  }
  if (!config.content.tts) {
    config.content.tts = defaults.tts;
    return true;
  }
  const tts = config.content.tts;
  const normalizedProvider = normalizeTtsProvider(tts.provider);
  if (JSON.stringify(tts.provider) !== JSON.stringify(normalizedProvider)) {
    tts.provider = normalizedProvider;
    changed = true;
  }
  if (tts.fallbackToInternal === undefined) {
    tts.fallbackToInternal = true;
    changed = true;
  }
  return changed;
}

function normalizeTtsProvider(provider: unknown): TtsProviderConfig {
  if (typeof provider === 'string') {
    return { type: provider === 'loxberry-tts' ? 'loxberry-tts' : 'internal' } as TtsProviderConfig;
  }
  if (!provider || typeof provider !== 'object') {
    return { type: 'internal' };
  }
  const { port: legacyPort, ...raw } = provider as Partial<LoxBerryTtsProviderConfig> & { type?: string; port?: number };
  if (raw.type !== 'loxberry-tts') {
    return { type: 'internal' };
  }
  const mqttPort =
    typeof raw.mqttPort === 'number' && Number.isInteger(raw.mqttPort) && raw.mqttPort > 0 && raw.mqttPort <= 65535
      ? raw.mqttPort
      : typeof legacyPort === 'number' && Number.isInteger(legacyPort) && legacyPort > 0 && legacyPort <= 65535
        ? legacyPort
        : undefined;
  const timeoutMs =
    typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0
      ? Math.round(raw.timeoutMs)
      : undefined;
  return {
    ...raw,
    type: 'loxberry-tts',
    enabled: raw.enabled !== false,
    protocol: raw.protocol === 'mqtts' ? 'mqtts' : 'mqtt',
    mqttPort,
    timeoutMs,
  };
}

function normalizeZoneInputs(zone: ZoneConfig): void {
  if (!zone.inputs) {
    zone.inputs = {};
  }
  if (!zone.inputs.airplay) {
    zone.inputs.airplay = { enabled: true };
  } else if ('model' in zone.inputs.airplay!) {
    // Do not persist model in config
    delete (zone.inputs.airplay as unknown as Record<string, unknown>).model;
  }
  if (!zone.inputs.spotify) {
    zone.inputs.spotify = {
      enabled: true,
      offload: false,
    };
  } else {
    const sp = zone.inputs.spotify as unknown as Record<string, unknown>;
    const connectVal = sp.connectEnabled ?? sp.offload;
    zone.inputs.spotify.offload = connectVal === true;
    // Drop legacy native flag if present.
    if ('native' in zone.inputs.spotify!) {
      delete (zone.inputs.spotify as unknown as Record<string, unknown>).native;
    }
  }
  if (!zone.inputs.musicassistant) {
    zone.inputs.musicassistant = { enabled: true, offload: false };
  } else {
    zone.inputs.musicassistant.enabled = zone.inputs.musicassistant.enabled !== false;
    zone.inputs.musicassistant.offload = zone.inputs.musicassistant.offload === true;
  }
}

function normalizeZoneOutput(zone: ZoneConfig): boolean {
  let changed = false;
  const legacyTransports = Array.isArray(zone.transports) ? zone.transports : null;
  if (zone.output === undefined) {
    zone.output = legacyTransports?.[0] ?? null;
    changed = true;
  } else if (zone.output === null && legacyTransports && legacyTransports.length > 0) {
    zone.output = legacyTransports[0] ?? null;
    changed = true;
  }
  if (legacyTransports) {
    delete zone.transports;
    changed = true;
  }
  return changed;
}

function normalizeZones(config: AudioServerConfig): boolean {
  if (!config.zones) return false;
  let outputMigrated = false;
  config.zones.forEach((zone) => {
    normalizeZoneInputs(zone);
    if (normalizeZoneOutput(zone)) {
      outputMigrated = true;
    }
  });
  return outputMigrated;
}

function normalizeSystem(config: AudioServerConfig): boolean {
  let changed = false;
  if (!config.system) {
    config.system = defaultConfig().system;
    return true;
  }
  if (!config.system.miniserver) {
    config.system.miniserver = defaultConfig().system.miniserver;
    changed = true;
  } else if (
    typeof config.system.miniserver.port !== 'number' ||
    !Number.isInteger(config.system.miniserver.port) ||
    config.system.miniserver.port <= 0 ||
    config.system.miniserver.port > 65535
  ) {
    config.system.miniserver.port = 80;
    changed = true;
  }
  if (config.system.miniserver.protocol !== 'http' && config.system.miniserver.protocol !== 'https') {
    config.system.miniserver.protocol = 'http';
    changed = true;
  }
  if (!config.system.audioserver) {
    config.system.audioserver = defaultConfig().system.audioserver;
    return true;
  }
  if (typeof config.system.audioserver.slimprotoPort !== 'number') {
    config.system.audioserver.slimprotoPort = 3483;
    changed = true;
  }
  if (typeof config.system.audioserver.slimprotoCliPort !== 'number') {
    config.system.audioserver.slimprotoCliPort = 9090;
    changed = true;
  }
  if (typeof config.system.audioserver.slimprotoJsonPort !== 'number') {
    config.system.audioserver.slimprotoJsonPort = 9000;
    changed = true;
  }
  if ('alertPreDelayMs' in config.system.audioserver) {
    delete (config.system.audioserver as Record<string, unknown>).alertPreDelayMs;
    changed = true;
  }
  if (config.system.audioserver.authEnabled === undefined) {
    config.system.audioserver.authEnabled = true;
    changed = true;
  }
  return changed;
}

function normalizeInputs(config: AudioServerConfig): void {
  if (!config.inputs) {
    config.inputs = {};
  }
  if (!config.inputs.airplay) {
    config.inputs.airplay = { enabled: true };
  }
  if (!config.inputs.spotify) {
    config.inputs.spotify = { enabled: true };
  }
  if (!config.inputs.bluetooth) {
    config.inputs.bluetooth = { enabled: false };
  }
  if (!config.inputs.lineIn) {
    config.inputs.lineIn = { inputs: [] };
  } else {
    if ('source' in config.inputs.lineIn) {
      delete (config.inputs.lineIn as Record<string, unknown>).source;
    }
    if (!Array.isArray(config.inputs.lineIn.inputs)) {
      config.inputs.lineIn.inputs = [];
    }
  }
}

function normalizeGroups(config: AudioServerConfig): void {
  if (!config.groups) {
    config.groups = { mixedGroupEnabled: false, powerGroups: [], audioGroups: [] };
    return;
  }
  if (config.groups.mixedGroupEnabled !== true) {
    config.groups.mixedGroupEnabled = false;
  }
  if (!Array.isArray(config.groups.powerGroups)) {
    config.groups.powerGroups = [];
  }
  if (!Array.isArray(config.groups.audioGroups)) {
    config.groups.audioGroups = [];
  }
}
