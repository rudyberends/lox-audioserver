import type { ConfigPort } from '@/ports/ConfigPort';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { ContentFolder } from '@/ports/ContentTypes';

/**
 * One browsable top-level service the server can expose to an external content
 * client (the DLNA MediaServer's ContentDirectory, the Subsonic API, …).
 *
 * `key` is the stable identity used in the client-facing object/entity ids: the
 * literals `library`/`radio` for the built-ins, or a per-instance **bridge id**
 * for streaming services. The bridge id matters: `getServiceFolder(service, user)`
 * only resolves the right provider when `user` is that bridge id — the generic
 * provider name does NOT resolve a bridge, and one provider type can have several
 * bridges (one per account), each of which is its own service here.
 *
 * `id3Probe` is the folder whose children carry the collection entry points
 * ("Albums"/"Artists"/"Playlists"). For a streaming bridge that is its root; for
 * the local library the root lists storages, so it points one level deeper.
 */
export type BrowsableService = {
  key: string;
  /** Provider type — used for allowlist matching and default titles. */
  provider: string;
  title: string;
  /** Native folder id for this service's own top level. */
  rootFolderId: string;
  /** Folder to probe for collection entry points, when different from the root. */
  id3Probe: string;
  /** `globalSearch` source for this service, or null when it cannot search. */
  searchSource: string | null;
  browse: (
    cm: ContentManager,
    folderId: string,
    offset: number,
    limit: number,
  ) => Promise<ContentFolder | null>;
};

const PROVIDER_TITLES: Record<string, string> = {
  library: 'Library',
  radio: 'Radio',
  spotify: 'Spotify',
  soundcloud: 'SoundCloud',
  applemusic: 'Apple Music',
  deezer: 'Deezer',
  tidal: 'Tidal',
  ytmusic: 'YouTube Music',
  youtube: 'YouTube',
  musicassistant: 'Music Assistant',
};

export function providerTitle(provider: string): string {
  return PROVIDER_TITLES[provider] ?? provider;
}

/**
 * Normalise a configured provider allowlist. `null` means "no restriction" —
 * an empty array is treated the same, so an accidentally-empty list does not
 * silently hide everything.
 */
export function parseProviderAllowlist(providers?: string[] | null): Set<string> | null {
  if (!providers || providers.length === 0) {
    return null;
  }
  const allow = new Set(providers.map((p) => String(p).trim().toLowerCase()).filter(Boolean));
  return allow.size > 0 ? allow : null;
}

/**
 * Build the catalogue of browsable services from config: the local library, the
 * built-in radio tile, and one entry per enabled streaming bridge (so multiple
 * accounts of the same provider each get their own service).
 *
 * Called per request by its consumers so config changes take effect without a
 * restart.
 */
export function buildBrowsableServices(
  config: ConfigPort,
  allow: Set<string> | null = null,
): BrowsableService[] {
  const permitted = (provider: string): boolean => !allow || allow.has(provider);
  const services: BrowsableService[] = [];

  if (permitted('library')) {
    services.push({
      key: 'library',
      provider: 'library',
      title: providerTitle('library'),
      rootFolderId: 'root',
      // The library root lists storages; the collection categories (Albums /
      // Artists / Tracks / Folders) live under the local storage folder.
      id3Probe: 'library-local',
      searchSource: 'local',
      browse: (cm, folderId, offset, limit) => cm.getMediaFolder(folderId, offset, limit),
    });
  }

  if (permitted('radio')) {
    services.push({
      key: 'radio',
      provider: 'radio',
      title: providerTitle('radio'),
      rootFolderId: 'start',
      id3Probe: 'start',
      // Radio is a stream directory, not a searchable track catalogue.
      searchSource: null,
      browse: (cm, folderId, offset, limit) =>
        cm.getServiceFolder('radioparadise', 'radioparadise', folderId, offset, limit),
    });
  }

  const bridges = config.getConfig().content.streamingServices ?? [];
  for (const bridge of bridges) {
    if (!bridge || bridge.enabled === false || !bridge.id) {
      continue;
    }
    const provider = bridge.provider?.trim().toLowerCase();
    if (!provider || !permitted(provider)) {
      continue;
    }
    const bridgeId = bridge.id;
    services.push({
      key: bridgeId,
      provider,
      title: bridge.label?.trim() || providerTitle(provider),
      rootFolderId: 'root',
      id3Probe: 'root',
      // The service manager registers every bridge provider under this key.
      searchSource: `spotify@${bridgeId}`,
      browse: (cm, folderId, offset, limit) =>
        cm.getServiceFolder(provider, bridgeId, folderId, offset, limit),
    });
  }

  return services;
}
