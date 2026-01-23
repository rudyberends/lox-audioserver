import type { AudioServerConfig, RawAudioConfig } from '@/domain/config/types';

export interface ConfigPort {
  load(): Promise<AudioServerConfig>;
  getConfig(): AudioServerConfig;
  getSystemConfig(): AudioServerConfig['system'];
  getRawAudioConfig(): RawAudioConfig;
  ensureInputs(): void;
  updateConfig(
    mutator: (config: AudioServerConfig) => void | Promise<void>,
  ): Promise<AudioServerConfig>;
}

export type { AudioServerConfig, RawAudioConfig };
