import axios from 'axios';
import { config } from '../../../config/config';
import logger from '../../../utils/troxorlogger';
import { RadioEntry, RadioFolderItem, RadioFolderResponse } from '../types';

/** Raw BeoContent payload describing NetRadio favourites. */
interface FavoriteStationResponse {
  favoriteListStationList?: {
    total?: number;
    favoriteListStation?: Array<BeolinkFavoriteStation>;
  };
}

/** Individual favourite entry pulled from BeoContent. */
interface BeolinkFavoriteStation {
  id?: string;
  station?: {
    id?: string;
    name?: string;
    liveDescription?: string;
    image?: Array<{ url?: string }>;
  };
}

/** Lightweight cache wrapper so we avoid hitting BeoContent every request. */
interface CachedFavorites {
  fetchedAt: number;
  items: RadioFolderItem[];
}

/** Construction options for the Beolink radio proxy. */
interface BeolinkRadioOptions {
  host: string;
  ttlSeconds: number;
  favoritesName: string;
  iconProxyId: string;
  providerLabel: string;
  serviceId: string;
}

const FAVORITES_ICON_KEY = 'radiocustom';
const LOCAL_SERVICE_CMD = 'local';
const CUSTOM_SERVICE_CMD = 'custom';

/**
 * Proxies Beolink NetRadio favourites into the Loxone radio provider contract.
 */
export class BeolinkRadioService {
  private cache: CachedFavorites | null = null;

  constructor(private readonly options: BeolinkRadioOptions) {}

  /** Fetch and return the root radio categories aligned with Music Assistant. */
  async getRadios(): Promise<RadioEntry[]> {
    const favorites = await this.loadFavorites();
    const icon = favorites.find((item) => item.coverurl)?.coverurl ?? this.buildIconUrl();

    return [
      {
        cmd: LOCAL_SERVICE_CMD,
        name: `${this.options.providerLabel} Radio`,
        icon,
        root: 'start',
      },
      {
        cmd: CUSTOM_SERVICE_CMD,
        name: `${this.options.providerLabel} Custom Radios`,
        icon,
        root: 'start',
      },
    ];
  }

  /** Slice favourites for the requested offset/limit. */
  async getServiceFolder(
    service: string,
    folderId: string,
    _user: string,
    offset: number,
    limit: number,
  ): Promise<RadioFolderResponse> {
    const normalizedService = this.normalizeService(service);
    const favorites = normalizedService === CUSTOM_SERVICE_CMD ? [] : await this.loadFavorites();
    const items = normalizedService === CUSTOM_SERVICE_CMD ? [] : favorites.slice(offset, offset + limit);
    return {
      id: folderId || 'start',
      name: '/',
      service,
      totalitems: favorites.length,
      start: offset,
      items,
    };
  }

  /** Locate a station by id/audiopath (case-insensitive). */
  async resolveStation(service: string, stationId: string): Promise<RadioFolderItem | undefined> {
    const favorites = await this.loadFavorites();
    const normalized = stationId.trim().toLowerCase();
    const prefix = `${service.toLowerCase()}:`;
    return favorites.find((item) => {
      const id = item.id.toLowerCase();
      const path = item.audiopath.toLowerCase();
      return id === normalized || path === normalized || `${prefix}${id}` === normalized;
    });
  }

  private normalizeService(service: string): string {
    if (!service) {
      return LOCAL_SERVICE_CMD;
    }
    const lowered = service.toLowerCase();
    if (lowered === this.options.serviceId.toLowerCase()) {
      return LOCAL_SERVICE_CMD;
    }
    if (lowered === 'favorites') {
      return LOCAL_SERVICE_CMD;
    }
    if (lowered === CUSTOM_SERVICE_CMD) {
      return CUSTOM_SERVICE_CMD;
    }
    if (lowered === LOCAL_SERVICE_CMD) {
      return LOCAL_SERVICE_CMD;
    }
    return lowered;
  }

  /** Fetches BeoContent favourites with simple TTL caching. */
  private async loadFavorites(): Promise<RadioFolderItem[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < this.options.ttlSeconds * 1000) {
      return this.cache.items;
    }
    const url = `http://${this.options.host}:8080/BeoContent/radio/netRadioProfile/favoriteList/favorite/favoriteListStation`;
    try {
      const response = await axios.get<FavoriteStationResponse>(url, { timeout: 5000 });
      const rawStations = response.data.favoriteListStationList?.favoriteListStation ?? [];
      const mapped = rawStations
        .map((station, index) => mapStationToRadioItem(station, index))
        .filter(Boolean) as RadioFolderItem[];
      this.cache = { fetchedAt: now, items: mapped };
      logger.debug(`[BeolinkProvider] Loaded ${mapped.length} radio favorites from ${this.options.host}`);
      return mapped;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[BeolinkProvider] Failed to fetch radio favorites from ${this.options.host}: ${message}`);
      this.cache = { fetchedAt: now, items: [] };
      return [];
    }
  }

  /** Reuses the legacy icon used for Beolink favourites. */
  private buildIconUrl(): string {
    const iconHost =
      process.env.RADIO_ICON_HOST ||
      config.audioserver?.ip ||
      process.env.AUDIOSERVER_IP ||
      '127.0.0.1';
    return `http://${iconHost}:7091/imgcache/?item=${FAVORITES_ICON_KEY}&viaproxy=${this.options.iconProxyId}`;
  }
}

/** Maps a Beolink preset to the Loxone radio folder format. */
function mapStationToRadioItem(station: BeolinkFavoriteStation, index: number): RadioFolderItem | undefined {
  const data = station.station;
  if (!data?.id) return undefined;
  const cover = Array.isArray(data.image) && data.image.length > 0 ? data.image[0]?.url ?? '' : '';
  return {
    id: data.id,
    name: data.name ?? `Station ${index}`,
    station: data.liveDescription ?? '',
    audiopath: data.id,
    coverurl: cover,
    contentType: 'Playlists',
    sort: '',
    type: 2,
  };
}
