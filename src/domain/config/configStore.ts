import { asyncCrc32 } from '@/core/utils/crc32';
import {
  ensureDir,
  readOrDefaultJson,
  resolveDataDir,
  writeJson,
} from '@/core/utils/file';
import { defaultMacId } from '@/core/utils/mac';
import { defaultLocalIp } from '@/core/utils/net';
import type { AudioServerConfig, RawAudioConfig, ZoneConfig } from '@/domain/config/types';

const CONFIG_PATH = resolveDataDir('config.json');

/**
 * Minimal configuration store backed by a JSON file on disk.
 */
class ConfigStore {
  private config: AudioServerConfig | null = null;

  public async load(): Promise<AudioServerConfig> {
    this.config = await readOrDefaultJson<AudioServerConfig>(
      CONFIG_PATH,
      defaultConfig(),
      true,
    );
    normalizeInputs(this.config);
    normalizeZones(this.config);
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
    normalizeInputs(this.config);
    normalizeZones(this.config);
  }

  public getSystem(): AudioServerConfig['system'] {
    return this.get().system;
  }

  public getRawAudioConfig(): RawAudioConfig {
    return this.get().rawAudioConfig;
  }

  public async save(): Promise<void> {
    await ensureDir(resolveDataDir());
    await writeJson(CONFIG_PATH, this.get());
  }

  public async patch(
    mutator: (config: AudioServerConfig) => void | Promise<void>,
  ): Promise<AudioServerConfig> {
    if (!this.config) {
      await this.load();
    }

    await mutator(this.config!);
    normalizeInputs(this.config!);
    normalizeZones(this.config!);
    await this.save();
    return this.config!;
  }
}

const store = new ConfigStore();

export async function loadConfig(): Promise<AudioServerConfig> {
  return store.load();
}

export function getConfig(): AudioServerConfig {
  return store.get();
}

export function getSystemConfig(): AudioServerConfig['system'] {
  return store.getSystem();
}

export function getRawAudioConfig(): RawAudioConfig {
  return store.getRawAudioConfig();
}

export function ensureInputs(): void {
  store.ensureInputs();
}

export async function refreshMusicCrc(): Promise<void> {
  const config = store.get();
  const relevant = {
    zones: config.zones,
    content: config.content,
    extensions: config.system.audioserver.extensions,
  };

  const crc = await asyncCrc32(JSON.stringify(relevant));
  config.rawAudioConfig.crc32 = crc;
  await store.save();
}

export async function updateConfig(
  mutator: (config: AudioServerConfig) => void | Promise<void>,
): Promise<AudioServerConfig> {
  return store.patch(async (cfg) => {
    const before = serializeConfig(cfg);
    await mutator(cfg);
    normalizeInputs(cfg);
    normalizeZones(cfg);
    const after = serializeConfig(cfg);
    if (before !== after) {
      cfg.updatedAt = new Date().toISOString();
    }
  });
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
      },
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

function normalizeZones(config: AudioServerConfig): void {
  if (!config.zones) return;
  config.zones.forEach((zone) => normalizeZoneInputs(zone));
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
