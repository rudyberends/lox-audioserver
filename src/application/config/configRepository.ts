import path from 'node:path';
import type { StoragePort } from '@/ports/StoragePort';
import { defaultMacId } from '@/shared/utils/mac';
import { defaultLocalIp } from '@/shared/utils/net';
import type { AudioServerConfig, RawAudioConfig, ZoneConfig } from '@/domain/config/types';

const CONFIG_PATH = path.resolve(process.cwd(), 'data', 'config.json');

/**
 * Minimal configuration store backed by a JSON file on disk.
 */
export class ConfigRepository {
  private config: AudioServerConfig | null = null;

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
    normalizeInputs(this.config);
    normalizeGroups(this.config);
    const outputMigrated = normalizeZones(this.config);
    if (systemMigrated || outputMigrated) {
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
    if (!this.config) {
      await this.load();
    }

    await mutator(this.config!);
    normalizeSystem(this.config!);
    normalizeInputs(this.config!);
    normalizeGroups(this.config!);
    normalizeZones(this.config!);
    await this.save();
    return this.config!;
  }

  public async update(
    mutator: (config: AudioServerConfig) => void | Promise<void>,
  ): Promise<AudioServerConfig> {
    return this.patch(async (cfg) => {
      const before = serializeConfig(cfg);
      await mutator(cfg);
      normalizeSystem(cfg);
      normalizeInputs(cfg);
      normalizeGroups(cfg);
      normalizeZones(cfg);
      const after = serializeConfig(cfg);
      if (before !== after) {
        cfg.updatedAt = new Date().toISOString();
      }
    });
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
      miniserver: { ip: '', serial: '' },
      audioserver: {
        ip: defaultLocalIp(),
        name: 'Unconfigured',
        uuid: '',
        macId: defaultMacId(),
        paired: false,
        extensions: [],
        slimprotoPort: 3483,
        slimprotoCliPort: 9090,
        slimprotoJsonPort: 9000,
      },
      logging: {
        consoleLevel: 'info',
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

function normalizeZoneInputs(zone: ZoneConfig): void {
  if (!zone.inputs) {
    zone.inputs = {};
  }
  if (!zone.inputs.airplay) {
    zone.inputs.airplay = { enabled: true };
  } else if ('model' in zone.inputs.airplay!) {
    // Do not persist model in config
    delete (zone.inputs.airplay as any).model;
  }
  if (!zone.inputs.spotify) {
    zone.inputs.spotify = {
      enabled: true,
      offload: false,
    };
  } else {
    const connectVal = (zone.inputs.spotify as any).connectEnabled ?? (zone.inputs.spotify as any).offload;
    zone.inputs.spotify.offload = connectVal === true;
    // Drop legacy native flag if present.
    if ('native' in zone.inputs.spotify!) {
      delete (zone.inputs.spotify as any).native;
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
    delete (zone as any).transports;
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
      delete (config.inputs.lineIn as any).source;
    }
    if (!Array.isArray(config.inputs.lineIn.inputs)) {
      config.inputs.lineIn.inputs = [];
    }
  }
}

function normalizeGroups(config: AudioServerConfig): void {
  if (!config.groups) {
    config.groups = { mixedGroupEnabled: false };
    return;
  }
  if (config.groups.mixedGroupEnabled !== true) {
    config.groups.mixedGroupEnabled = false;
  }
}
