import logger from '../../utils/troxorlogger';
import { MediaProvider } from './types';
import { DummyProvider } from './dummyProvider';
import { MusicAssistantProvider } from './musicAssistant';
import { BeolinkProvider } from './beoLink';

type ProviderCtor = () => MediaProvider;

const providers: Record<string, ProviderCtor> = {
  DummyProvider: () => new DummyProvider(),
  MusicAssistantProvider: () => new MusicAssistantProvider(),
  BeolinkProvider: () => new BeolinkProvider(),
};

const providerAliases: Record<string, keyof typeof providers> = {
  MusicAssistantRadioProvider: 'MusicAssistantProvider',
  BeoLinkProvider: 'BeolinkProvider',
};

/** Returns the canonical list of registered media provider keys. */
export function listProviders(): string[] {
  return Object.keys(providers);
}

let cachedProvider: MediaProvider | undefined;

/**
 * Resolve the media provider configured via `MEDIA_PROVIDER`, instantiating once and reusing it.
 * Falls back to the dummy provider when no match is found so the server keeps serving empty data.
 */
export function getMediaProvider(): MediaProvider {
  if (!cachedProvider) {
    const rawKey = process.env.MEDIA_PROVIDER?.trim();
    const resolvedKey = rawKey ? providerAliases[rawKey] ?? rawKey : 'DummyProvider';
    const ctor = (providers as Record<string, ProviderCtor>)[resolvedKey];

    if (ctor) {
      logger.info(`[ProviderFactory] Using media provider: ${resolvedKey}`);
      cachedProvider = ctor();
    } else {
      logger.warn(
        `[ProviderFactory] Unknown MEDIA_PROVIDER "${rawKey}". Falling back to DummyProvider.`,
      );
      cachedProvider = providers.DummyProvider();
    }
  }
  return cachedProvider;
}

/**
 * Clear the cached provider, forcing the next lookup to re-read configuration and rebuild the instance.
 */
export function resetMediaProvider(): void {
  if (cachedProvider) {
    logger.info('[ProviderFactory] Reset media provider cache');
  }
  cachedProvider = undefined;
}
