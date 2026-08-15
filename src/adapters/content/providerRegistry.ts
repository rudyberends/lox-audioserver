import type { StreamingServiceConfig } from '@/ports/ContentTypes';
import type { ContentProvider } from '@/adapters/content/ContentProvider';
import { AppleMusicProvider } from '@/adapters/content/providers/applemusic/appleMusicProvider';
import { DeezerProvider } from '@/adapters/content/providers/deezer/deezerProvider';
import { TidalProvider } from '@/adapters/content/providers/tidal/tidalProvider';
import { MusicAssistantBridgeProvider } from '@/adapters/content/providers/musicassistant/musicAssistantBridgeProvider';
import { YtMusicProvider } from '@/adapters/content/providers/ytmusic/ytmusicProvider';
import { YoutubeProvider } from '@/adapters/content/providers/youtube/youtubeProvider';
import { SoundCloudProvider } from '@/adapters/content/providers/soundcloud/soundcloudProvider';

/**
 * What a provider needs to know about the account it is being built for.
 *
 * `serviceNativePrefix` is the identity it puts in the ids and audiopaths it emits —
 * `applemusic`, or `applemusic:p0gngd` once a second account of that service makes the bare
 * name ambiguous. `providerId` is only the key it is registered under.
 */
export type ProviderConstructionArgs = {
  providerId: string;
  serviceNativePrefix: string;
  label: string;
  bridge: StreamingServiceConfig;
  /** Host to build cover-proxy URLs against, for services whose artwork we re-serve. */
  coverHost: string;
};

export type ProviderDefinition = {
  /** Provider id as it appears in config and in a service-native identity. */
  id: string;
  /** Name for a person to read, when the account carries no label of its own. */
  title: string;
  create: (args: ProviderConstructionArgs) => ContentProvider;
};

/**
 * Every content service this server can be configured with.
 *
 * One table instead of a branch per service in each of the places that used to need the list:
 * the construction chain in the registry, the name table beside it, the titles in
 * `browsableServices`, and — with {@link '@/adapters/content/ContentProvider'} — the union type
 * and the `instanceof` cascade. Adding a service is an entry here plus a row in
 * `providerCapabilities`, which is deliberately separate: what a service *is* and what it can
 * *do* are answered by different code and change at different times.
 *
 * Spotify is absent on purpose. Its accounts predate the neutral `content.streamingServices`
 * surface and carry their own credentials and token rotation, so the registry builds them from
 * `content.spotify.accounts` instead. It is a provider like the rest of them at the
 * {@link ContentProvider} contract — just not one this table can construct.
 */
export const CONTENT_PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: 'musicassistant',
    title: 'Music Assistant',
    create: ({ providerId, serviceNativePrefix, label, bridge }) =>
      new MusicAssistantBridgeProvider({
        providerId,
        serviceNativePrefix,
        label,
        host: bridge.host,
        port: bridge.port,
        apiKey: bridge.apiKey,
        accountId: bridge.accountId ?? bridge.id,
      }),
  },
  {
    id: 'applemusic',
    title: 'Apple Music',
    create: ({ providerId, serviceNativePrefix, label, bridge, coverHost }) =>
      new AppleMusicProvider({
        providerId,
        serviceNativePrefix,
        label,
        developerToken: bridge.developerToken,
        userToken: bridge.userToken,
        coverHost,
      }),
  },
  {
    id: 'deezer',
    title: 'Deezer',
    create: ({ providerId, serviceNativePrefix, label, bridge }) =>
      new DeezerProvider({
        providerId,
        serviceNativePrefix,
        label,
        arl: bridge.deezerArl,
      }),
  },
  {
    id: 'tidal',
    title: 'Tidal',
    create: ({ providerId, serviceNativePrefix, label, bridge }) =>
      new TidalProvider({
        providerId,
        serviceNativePrefix,
        label,
        accessToken: bridge.tidalAccessToken,
        countryCode: bridge.tidalCountryCode,
      }),
  },
  {
    id: 'ytmusic',
    title: 'YouTube Music',
    create: ({ providerId, serviceNativePrefix, label, bridge }) =>
      new YtMusicProvider({ providerId, serviceNativePrefix, label, bridge }),
  },
  {
    id: 'youtube',
    title: 'YouTube',
    create: ({ providerId, serviceNativePrefix, label, bridge }) =>
      new YoutubeProvider({ providerId, serviceNativePrefix, label, bridge }),
  },
  {
    id: 'soundcloud',
    title: 'SoundCloud',
    create: ({ providerId, serviceNativePrefix, label, bridge }) =>
      new SoundCloudProvider({
        providerId,
        serviceNativePrefix,
        label,
        oauthToken: bridge.soundcloudOauthToken,
        clientId: bridge.soundcloudClientId,
      }),
  },
];

const BY_ID = new Map(CONTENT_PROVIDERS.map((definition) => [definition.id, definition]));

/** The definition for a configured provider id, or null when nothing implements it. */
export function providerDefinition(provider: string | undefined | null): ProviderDefinition | null {
  return BY_ID.get((provider ?? '').trim().toLowerCase()) ?? null;
}

/**
 * The name to show for a provider id.
 *
 * `library`, `radio` and `spotify` are not in the table above — the first two are built in and
 * Spotify is constructed elsewhere — but they are still services a consumer can be looking at,
 * so they are named here too rather than in a second table.
 */
const EXTRA_TITLES: Record<string, string> = {
  library: 'Library',
  radio: 'Radio',
  spotify: 'Spotify',
};

export function providerTitle(provider: string): string {
  const key = (provider || '').trim().toLowerCase();
  return BY_ID.get(key)?.title ?? EXTRA_TITLES[key] ?? provider;
}
