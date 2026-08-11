import type { ConfigPort } from '@/ports/ConfigPort';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { ContentFolder, ContentFolderItem } from '@/ports/ContentTypes';
import type { ProviderCapabilities } from '@/ports/ProviderCapabilities';
import { capabilitiesFor } from '@/adapters/content/providerCapabilities';
import {
  searchSourceFromServiceKey,
  serviceNativeKey,
} from '@/domain/media/serviceIdentity';

/**
 * One browsable top-level service the server can expose to an external content
 * client (the DLNA MediaServer's ContentDirectory, the Subsonic API, …).
 *
 * `key` is the stable identity used in the client-facing object/entity ids: the
 * literals `library`/`radio` for the built-ins, and the service-native name for a
 * streaming account (`applemusic`, or `applemusic:p0gngd` when a service has more
 * than one). One provider type can have several accounts, each of which is its own
 * service here. Deliberately NOT the Loxone bridge id: that word describes a
 * disguise these clients are not party to.
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
  /**
   * What this service can actually do — which item kinds its search returns, and whether
   * its catalogue is larger than the user's collection.
   *
   * Distinct from `searchSource`, which only names the search *endpoint*: two services can
   * both be searchable and disagree about albums. A consumer should offer the kinds listed
   * here rather than assume every service serves the same set, which is what
   * `globalsearch/describe` used to assert for all of them.
   */
  capabilities: ProviderCapabilities;
  browse: (
    cm: ContentManager,
    folderId: string,
    offset: number,
    limit: number,
  ) => Promise<ContentFolder | null>;
  /**
   * The artists this service itself puts beside one of its own, when it has the notion.
   *
   * Absent for the local library and the radio tile, and that absence is the point: "who else
   * would I like" is editorial data a catalogue owner has and a folder of files does not.
   */
  relatedArtists?: (
    cm: ContentManager,
    folderId: string,
    limit: number,
  ) => Promise<ContentFolderItem[]>;
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
      // The library root lists storages; the collection categories live under
      // each storage folder. Both local and NAS storage expose albums, artists
      // and tracks; Local Media also exposes the user-managed playlists.
      id3Probe: 'library-local',
      searchSource: 'local',
      capabilities: capabilitiesFor('library'),
      browse: (cm, folderId, offset, limit) => cm.getMediaFolder(folderId, offset, limit),
    });
  }

  // One Radio root contains Radio Paradise, TuneIn presets and custom streams. Keep the
  // grouping here so clients do not need to know that these are backed by different providers.
  if (permitted('radio')) {
    services.push({
      key: 'radio',
      provider: 'radio',
      title: providerTitle('radio'),
      rootFolderId: 'start',
      id3Probe: 'start',
      // Radio is a stream directory, not a searchable track catalogue.
      searchSource: null,
      // Radio is browsable but its providers do not answer a general search.
      capabilities: capabilitiesFor('radio'),
      browse: (cm, folderId, offset, limit) => cm.getRadioFolder(folderId, offset, limit),
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
    // These consumers have no Spotify to be disguised as, so the account is named
    // service-natively here — `applemusic`, or `applemusic:p0gngd` when there is
    // more than one of that service. The Loxone bridge id never leaves its adapter.
    const key = serviceNativeKey(bridge, bridges);
    services.push({
      key,
      provider,
      title: bridge.label?.trim() || providerTitle(provider),
      rootFolderId: 'root',
      id3Probe: 'root',
      searchSource: searchSourceFromServiceKey(key),
      capabilities: capabilitiesFor(provider),
      browse: (cm, folderId, offset, limit) =>
        cm.getServiceFolder(key, key, folderId, offset, limit),
      relatedArtists: (cm, folderId, limit) => cm.getRelatedArtists(key, key, folderId, limit),
    });
  }

  return services;
}
