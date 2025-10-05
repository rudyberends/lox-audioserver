import logger from '../../../utils/troxorlogger';
import { config } from '../../../config/config';
import { RadioEntry, RadioFolderItem, RadioFolderResponse } from '../types';
import { MusicAssistantProviderClient } from './providerClient';

const FAVORITES_CATEGORY = {
  key: 'local',
  defaultName: 'Radio Favorieten',
  iconKey: 'radiocustom',
};

const DEFAULT_REFRESH_INTERVAL_MS = Number(process.env.MUSICASSISTANT_RADIO_REFRESH_MS || 60_000);

/**
 * MusicAssistantRadioService – syncs radio favorites from Music Assistant and presents them
 * through the MediaProvider radio API with local caching and key normalization.
 */
export class MusicAssistantRadioService {
  private cache: RadioEntry[];
  private favorites: RadioFolderItem[] = [];
  private stationLookup = new Map<string, RadioFolderItem>();
  private loading?: Promise<void>;
  private lastRefresh = 0;

  constructor(
    private readonly client: MusicAssistantProviderClient,
    private readonly refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
  ) {
    this.cache = [this.buildCategoryEntry()];
    this.loading = this.refreshFavorites();
  }

  /** Return the radio category list, refreshing favorites when stale. */
  async getRadios(): Promise<RadioEntry[]> {
    await this.ensureFavoritesLoaded();
    return this.cache;
  }

  /** Provide a slice of the favorites folder for the Loxone UI. */
  async getServiceFolder(
    service: string,
    _folderId: string,
    _user: string,
    offset: number,
    limit: number,
  ): Promise<RadioFolderResponse> {
    await this.ensureFavoritesLoaded();

    const items = this.favorites.slice(offset, offset + limit);

    return {
      id: 'start',
      name: '/',
      service,
      totalitems: this.favorites.length,
      start: offset,
      items,
    };
  }

  /** Expose the cached favorites for diagnostics. */
  async getFavoritesSnapshot(): Promise<RadioFolderItem[]> {
    await this.ensureFavoritesLoaded();
    return this.favorites;
  }

  /** Resolve a station id (or alias) back to its folder item. */
  resolveStation(service: string, stationId: string): RadioFolderItem | undefined {
    const keys = normalizeStationKeys(stationId);
    keys.push(`${service.toLowerCase()}:${stationId.toLowerCase()}`);
    for (const key of keys) {
      const found = this.stationLookup.get(key);
      if (found) return found;
    }
    return undefined;
  }

  /** Ensures favorites are refreshed once per interval and caches stay warm. */
  private async ensureFavoritesLoaded(): Promise<void> {
    const stale = Date.now() - this.lastRefresh > this.refreshIntervalMs;
    if (!this.loading && (stale || this.favorites.length === 0)) {
      this.loading = this.refreshFavorites();
    }

    if (this.loading) {
      try {
        await this.loading;
      } catch {
        // Errors logged in refreshFavorites
      } finally {
        this.loading = undefined;
      }
    }
  }

  /** Pulls fresh favorites from Music Assistant and rebuilds the lookup caches. */
  private async refreshFavorites(): Promise<void> {
    try {
      const rawFavorites = await this.loadFavorites();
      const enriched = await this.enrichStations(rawFavorites);

      const items: RadioFolderItem[] = [];
      this.stationLookup.clear();

      enriched.forEach((station, idx) => {
        const item = this.toFolderItem(station, idx);
        items.push(item);
        this.registerStationKeys(item, station);
      });

      this.favorites = items;
      this.cache = [this.buildCategoryEntry()];
      this.lastRefresh = Date.now();
      logger.info(`[MusicAssistantProvider] Loaded ${items.length} radio favorites`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[MusicAssistantProvider] Failed to load radio favorites: ${message}`);
    }
  }

  /** Executes the RPC that lists radio favorites stored in Music Assistant. */
  private async loadFavorites(): Promise<any[]> {
    try {
      const limit = Number(process.env.MUSICASSISTANT_RADIO_LIMIT || 200);
      const response = await this.client.rpc('music/radios/library_items', {
        favorite: true,
        limit,
        offset: 0,
      });

      if (Array.isArray(response)) return response;
      if (response?.items && Array.isArray(response.items)) return response.items;
    } catch (error) {
      logger.warn(
        `[MusicAssistantProvider] music/radios/library_items failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return [];
  }

  /** Fetches per-station metadata so we can expose icons/streams beyond the base listing. */
  private async enrichStations(stations: any[]): Promise<any[]> {
    const limit = Number(process.env.MUSICASSISTANT_RADIO_ENRICH_LIMIT || stations.length || 50);
    const slice = stations.slice(0, limit);

    const detailed = await Promise.all(
      slice.map(async (station) => {
        const itemId = toStringValue(station?.item_id);
        const providerInstance = this.resolveProviderInstance(station);

        if (!itemId || !providerInstance) {
          return station;
        }

        try {
          const detail = await this.client.rpc('music/radios/get_radio', {
            item_id: itemId,
            provider_instance_id_or_domain: providerInstance,
          });
          return { ...station, detail };
        } catch (error) {
          logger.debug(
            `[MusicAssistantProvider] get_radio failed for ${itemId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return station;
        }
      }),
    );

    const remainder = stations.slice(limit);
    return detailed.concat(remainder);
  }

  /** Builds the single radio category entry that points to the favorites folder. */
  private buildCategoryEntry(): RadioEntry {
    const iconHost =
      process.env.RADIO_ICON_HOST ||
      config.audioserver?.ip ||
      process.env.AUDIOSERVER_IP ||
      '127.0.0.1';
    const proxyId = process.env.RADIO_ICON_PROXY || 'musicassistant';
    const envName = process.env.RADIO_CATEGORY_FAVORITES_NAME;

    return {
      cmd: FAVORITES_CATEGORY.key,
      name: envName || FAVORITES_CATEGORY.defaultName,
      icon: `http://${iconHost}:7091/imgcache/?item=${FAVORITES_CATEGORY.iconKey}&viaproxy=${proxyId}`,
      root: 'start',
    };
  }

  /** Normalizes a Music Assistant radio favorite into a folder item for the UI. */
  private toFolderItem(station: any, index: number): RadioFolderItem {
    const name = toStringValue(station?.name ?? station?.title ?? `Station ${index}`);
    const streamUri = this.resolveStream(station);
    const id = streamUri || toStringValue(station?.item_id ?? station?.uri ?? name ?? `station-${index}`);
    const stationName =
      toStringValue(station?.metadata?.description) ||
      toStringValue(station?.station) ||
      name;
    const audiopath = streamUri || id;
    const coverurl = this.extractStationIcon(station);

    return {
      id,
      name,
      station: stationName || name,
      audiopath,
      coverurl,
      contentType: 'Playlists',
      sort: '',
      type: 2,
      provider: this.resolveProviderInstance(station),
    };
  }

  /** Chooses the best available icon URL for a station, falling back to the proxy. */
  private extractStationIcon(station: any): string {
    const metaImages = Array.isArray(station?.detail?.metadata?.images)
      ? station.detail.metadata.images
      : Array.isArray(station?.metadata?.images)
        ? station.metadata.images
        : [];

    const firstImage =
      metaImages.length > 0 ? toStringValue(metaImages[0]?.path || metaImages[0]?.url) : '';
    if (firstImage) return firstImage;

    const iconHost =
      process.env.RADIO_ICON_HOST ||
      config.audioserver?.ip ||
      process.env.AUDIOSERVER_IP ||
      '127.0.0.1';
    const proxyId = process.env.RADIO_ICON_PROXY || 'musicassistant';

    return `http://${iconHost}:7091/imgcache/?item=${FAVORITES_CATEGORY.iconKey}&viaproxy=${proxyId}`;
  }

  /** Determines which provider instance produced the station entry. */
  private resolveProviderInstance(station: any): string {
    const direct = toStringValue(station?.provider);
    if (direct) return direct;

    if (Array.isArray(station?.provider_mappings) && station.provider_mappings.length > 0) {
      const mapping = station.provider_mappings[0];
      return (
        toStringValue(mapping?.provider_instance) ||
        toStringValue(mapping?.provider_domain)
      );
    }

    return 'library';
  }

  /** Attempts to find a playable stream URI for the station. */
  private resolveStream(station: any): string {
    const libraryUri = toStringValue(station?.uri ?? station?.item_id);
    if (libraryUri.startsWith('library://')) return libraryUri;

    const detail = station?.detail;
    const detailUri = toStringValue(detail?.uri ?? detail?.stream ?? '');
    if (detailUri.startsWith('library://')) return detailUri;

    if (detailUri) return detailUri;

    const providerMappings = Array.isArray(station?.provider_mappings)
      ? station.provider_mappings
      : [];
    for (const mapping of providerMappings) {
      const mappedUri = toStringValue(mapping?.url ?? mapping?.stream ?? mapping?.item_id ?? '');
      if (mappedUri) {
        if (mappedUri.startsWith('tunein:station:')) return mappedUri;
        if (mappedUri.includes('tunein.com')) {
          const idMatch = mappedUri.match(/station\/(s\w+)/);
          if (idMatch) return `tunein:station:${idMatch[1]}`;
        }
        return mappedUri;
      }
    }

    if (libraryUri) return libraryUri;

    return '';
  }

  /** Stores all normalized keys that should resolve back to the station. */
  private registerStationKeys(item: RadioFolderItem, station: any): void {
    const keys = this.collectStationKeys(item, station);
    keys.forEach((key) => {
      this.stationLookup.set(key, item);
    });
  }

  /** Collects raw and normalized identifiers used for station lookups. */
  private collectStationKeys(item: RadioFolderItem, station: any): string[] {
    const rawKeys: string[] = [
      item.id,
      item.audiopath,
      toStringValue(station?.item_id),
      toStringValue(station?.uri),
      toStringValue(station?.detail?.uri),
      toStringValue(station?.detail?.stream),
    ];

    const mappings = Array.isArray(station?.provider_mappings) ? station.provider_mappings : [];
    mappings.forEach((mapping: any) => {
      rawKeys.push(
        toStringValue(mapping?.item_id),
        toStringValue(mapping?.url),
        toStringValue(mapping?.stream),
        toStringValue(mapping?.provider_domain),
        toStringValue(mapping?.provider_instance),
      );
    });

    const normalized = new Set<string>();
    rawKeys.forEach((value) => {
      normalizeStationKeys(value).forEach((key) => normalized.add(key));
    });

    return Array.from(normalized);
  }
}

function toStringValue(value: any): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return value.map((entry) => toStringValue(entry)).filter(Boolean).join(', ');
  }
  return '';
}

function normalizeStationKeys(value: string): string[] {
  if (!value) return [];
  const decoded = decodeURIComponent(value).trim();
  if (!decoded) return [];

  const lower = decoded.toLowerCase();
  const withoutParams = lower.split(/[?#]/)[0];
  const results = new Set<string>();

  const add = (val: string) => {
    if (val) results.add(val);
  };

  add(withoutParams);

  if (withoutParams.includes('--')) {
    add(withoutParams.split('--')[0]);
  }

  if (withoutParams.startsWith('tunein:station:')) {
    const rest = withoutParams.slice('tunein:station:'.length);
    add(`tunein:station:${rest}`);
    if (rest.includes('--')) {
      add(`tunein:station:${rest.split('--')[0]}`);
    }
    add(rest);
    if (rest.includes('--')) {
      add(rest.split('--')[0]);
    }
  }

  return Array.from(results);
}
