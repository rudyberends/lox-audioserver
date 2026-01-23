import type { ConfigPort } from '@/ports/ConfigPort';
import type { ConfigRepository } from '@/application/config/configRepository';

export class ConfigAdapter implements ConfigPort {
  constructor(private readonly repository: ConfigRepository) {}

  public load(): ReturnType<ConfigPort['load']> {
    return this.repository.load();
  }

  public getConfig(): ReturnType<ConfigPort['getConfig']> {
    return this.repository.get();
  }

  public getSystemConfig(): ReturnType<ConfigPort['getSystemConfig']> {
    return this.repository.getSystem();
  }

  public getRawAudioConfig(): ReturnType<ConfigPort['getRawAudioConfig']> {
    return this.repository.getRawAudioConfig();
  }

  public ensureInputs(): void {
    this.repository.ensureInputs();
  }

  public updateConfig(
    mutator: Parameters<ConfigPort['updateConfig']>[0],
  ): ReturnType<ConfigPort['updateConfig']> {
    return this.repository.update(mutator);
  }
}
