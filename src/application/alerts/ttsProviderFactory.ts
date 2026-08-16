import { LoxBerryTtsProvider } from '@/application/alerts/loxberryTtsProvider';
import { OpenAiTtsProvider } from '@/application/alerts/openAiTtsProvider';
import type { TtsProvider } from '@/application/alerts/ttsProvider';
import type { TtsProviderConfig } from '@/domain/config/types';

/**
 * Build the configured external provider, or `null` when there is none to build
 * — either because the internal provider is selected or because the configured
 * one is switched off. Callers treat `null` as "nothing external to try".
 */
export function createTtsProvider(config: TtsProviderConfig | undefined): TtsProvider | null {
  switch (config?.type) {
    case 'loxberry-tts':
      return config.enabled === false ? null : new LoxBerryTtsProvider(config);
    case 'openai-tts':
      return config.enabled === false ? null : new OpenAiTtsProvider(config);
    default:
      return null;
  }
}

/** True when the config names a provider other than the built-in one. */
export function isExternalTtsProvider(config: TtsProviderConfig | undefined): boolean {
  return Boolean(config) && config?.type !== 'internal';
}
