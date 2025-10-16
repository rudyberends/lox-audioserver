import MusicAssistantProviderClient from './client';
import { FavoriteItem, FavoriteResponse } from '../types';
import {
  mapAlbumToFolderItem,
  mapArtistToFolderItem,
  mapPlaylistToItem,
  mapRadioToFolderItem,
  mapTrackToMediaItem,
} from './mappers';
import {
  buildLibraryUri,
  extractAlbum,
  extractArtist,
  extractImage,
  extractItemId,
  extractName,
  extractProvider,
  extractUri,
  logError,
  normalizeMediaUri,
  safeNumber,
  toPlaylistCommandUri,
} from './utils';

type FavoritesPayload = {
  items: any[];
  total?: number;
};

/**
 * FavoritesController
 * -------------------
 * Handles loading, mapping, and caching of Music Assistant favorites.
 * The cache allows quick access to favorites (for example, when the client
 * triggers "play favorite") without requiring a new backend request.
 */
export class FavoritesController {
  /** Cache of favorites per zoneId (so we can look them up later by slot) */
  private favoritesCache: Map<number, FavoriteItem[]> = new Map();

  constructor(
    private readonly getClient: () => MusicAssistantProviderClient | undefined,
    private readonly fallbackProvider: string,
  ) {}

  /**
   * Fetch and map the favorites for a given zone.
   * This method:
   *  - Calls the Music Assistant API for multiple media types
   *  - Maps the results into the Loxone favorite schema
   *  - Stores the mapped list in a local cache for later retrieval
   */
  async getFavorites(zoneId: number, offset: number, limit: number): Promise<FavoriteResponse> {
    const client = this.getClient();
    if (!client) {
      this.favoritesCache.set(zoneId, []);
      return this.buildEmptyFavorites(zoneId, offset);
    }

    const payload = await this.loadFavorites(client, offset, limit);

    const mapped: FavoriteItem[] = [];
    payload.items.forEach((raw, index) => {
      const slotIndex = offset + index;
      const mappedItem = this.mapFavoriteItem(raw, slotIndex);
      if (mappedItem) {
        mapped.push(mappedItem);
      }
    });

    // Cache favorites so they can be used for playback later
    this.favoritesCache.set(zoneId, mapped);

    const total =
      payload.total !== undefined
        ? safeNumber(payload.total, mapped.length) ?? mapped.length
        : mapped.length;

    return {
      id: String(zoneId),
      name: 'Favorites',
      start: offset,
      totalitems: total,
      items: mapped,
      ts: Date.now(),
    };
  }

  /**
   * Internal helper that fetches all types of favorites from Music Assistant.
   * Iterates through several content types (tracks, albums, etc.)
   * and collects the combined result.
   */
  private async loadFavorites(
    client: MusicAssistantProviderClient,
    offset: number,
    limit: number,
  ): Promise<FavoritesPayload> {
    const types = ['tracks', 'albums', 'artists', 'playlists', 'radios'];
    const items: any[] = [];

    for (const type of types) {
      try {
        const result = await client.rpc<any>(`music/${type}/library_items`, {
          favorite: true,
          offset,
          limit,
        });
        if (Array.isArray(result)) items.push(...result);
      } catch (err) {
        logError(`music/${type}/library_items`, err);
      }
    }

    return { items, total: items.length };
  }

  /**
   * Maps a raw Music Assistant item into the standardized FavoriteItem format.
   * Handles multiple media types: track, album, playlist, artist, radio, etc.
   */
  private mapFavoriteItem(raw: any, slotIndex: number): FavoriteItem | null {
    const slot = slotIndex + 1;
    const item = this.unwrapMediaItem(raw);
    if (!item) return null;

    const mediaType = this.detectMediaType(item);

    switch (mediaType) {
      case 'track':
      case 'song':
      case 'audio': {
        const mapped = mapTrackToMediaItem(item, this.fallbackProvider);
        const audiopath = mapped.audiopath || mapped.id;
        if (!audiopath) return null;
        return this.buildFavorite({
          slot,
          name: mapped.name ?? mapped.title ?? extractName(item) ?? `Track ${slot}`,
          title: mapped.title ?? mapped.name,
          artist: mapped.artist ?? extractArtist(item),
          album: mapped.album ?? extractAlbum(item),
          coverurl: mapped.coverurl ?? extractImage(item) ?? '',
          audiopath,
          provider: mapped.provider ?? this.fallbackProvider,
          rawId: mapped.rawId ?? extractItemId(item),
          duration: mapped.duration,
          type: 'library_track',
          service: 'library',
        });
      }

      case 'playlist': {
        const mapped = mapPlaylistToItem(item, this.fallbackProvider);
        const audiopath =
          mapped.playlistCommandUri ?? mapped.audiopath ?? toPlaylistCommandUri(mapped.id);
        if (!audiopath) return null;
        return this.buildFavorite({
          slot,
          name: mapped.name ?? extractName(item) ?? `Playlist ${slot}`,
          title: mapped.name ?? extractName(item),
          coverurl: mapped.coverurl ?? extractImage(item) ?? '',
          audiopath,
          provider: mapped.provider ?? this.fallbackProvider,
          rawId: mapped.rawId ?? extractItemId(item),
          type: 'playlist',
          service: 'library',
          owner: item?.owner,
        });
      }

      case 'album': {
        const mapped = mapAlbumToFolderItem(item, this.fallbackProvider);
        const provider = extractProvider(item) ?? this.fallbackProvider;
        const audiopath =
          mapped.audiopath || buildLibraryUri('album', extractItemId(item) ?? '', provider);
        if (!audiopath) return null;
        return this.buildFavorite({
          slot,
          name: mapped.name ?? extractName(item) ?? `Album ${slot}`,
          title: mapped.name ?? extractName(item),
          artist: mapped.artist ?? extractArtist(item),
          album: mapped.album ?? extractName(item),
          coverurl: mapped.coverurl ?? extractImage(item) ?? '',
          audiopath,
          provider,
          rawId: extractItemId(item),
          type: 'library_folder',
          service: 'library',
        });
      }

      case 'artist': {
        const mapped = mapArtistToFolderItem(item, this.fallbackProvider);
        const provider = extractProvider(item) ?? this.fallbackProvider;
        const audiopath =
          mapped.audiopath || buildLibraryUri('artist', extractItemId(item) ?? '', provider);
        if (!audiopath) return null;
        return this.buildFavorite({
          slot,
          name: mapped.name ?? extractName(item) ?? `Artist ${slot}`,
          title: mapped.name ?? extractName(item),
          artist: mapped.artist ?? extractName(item),
          coverurl: mapped.coverurl ?? extractImage(item) ?? '',
          audiopath,
          provider,
          rawId: extractItemId(item),
          type: 'library_folder',
          service: 'library',
        });
      }

      case 'radio':
      case 'station': {
        const mapped = mapRadioToFolderItem(item, this.fallbackProvider);
        if (!mapped || !mapped.audiopath) return null;
        return this.buildFavorite({
          slot,
          name: mapped.name ?? extractName(item) ?? `Station ${slot}`,
          title: mapped.name ?? extractName(item),
          station: mapped.station ?? mapped.audiopath,
          coverurl: mapped.coverurl ?? extractImage(item) ?? '',
          audiopath: mapped.audiopath,
          provider: mapped.provider ?? extractProvider(item) ?? this.fallbackProvider,
          rawId: extractItemId(item),
          type: 'custom_stream',
          service: 'custom_stream',
        });
      }

      default: {
        const provider = extractProvider(item) ?? this.fallbackProvider;
        const rawId = extractItemId(item) ?? extractName(item) ?? '';
        const baseUri =
          extractUri(item, mediaType, rawId, provider) ??
          buildLibraryUri(mediaType || 'track', rawId, provider);
        const fallbackUri = normalizeMediaUri(baseUri);
        if (!fallbackUri) return null;
        return this.buildFavorite({
          slot,
          name: extractName(item) ?? `Item ${slot}`,
          title: extractName(item),
          artist: extractArtist(item),
          album: extractAlbum(item),
          coverurl: extractImage(item) ?? '',
          audiopath: fallbackUri,
          provider,
          rawId,
          type: 'library_track',
          service: 'library',
        });
      }
    }
  }

  /**
   * Helper to construct a standard FavoriteItem from extracted metadata.
   */
  private buildFavorite(entry: any): FavoriteItem {
    return {
      id: entry.slot, // numeric slot ID for Loxone compatibility
      slot: entry.slot,
      plus: false,
      name: entry.name,
      title: entry.title ?? entry.name,
      artist: entry.artist,
      album: entry.album,
      coverurl: entry.coverurl ?? '',
      audiopath: entry.audiopath,
      type: entry.type,
      service: entry.service,
      station: entry.station,
      owner: entry.owner,
      duration: entry.duration,
      provider: entry.provider ?? this.fallbackProvider,
      rawId: entry.rawId,
    };
  }

  /**
   * Detects the type of a media item (track, album, artist, etc.)
   * based on the available metadata fields.
   */
  private detectMediaType(item: any): string {
    const candidates = [
      item?.media_type,
      item?.type,
      item?.item_type,
      item?.category,
      item?.content_type,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim().toLowerCase();
    }
    const uri = extractUri(item) ?? '';
    if (uri.startsWith('radio://') || uri.toLowerCase().includes('station')) return 'radio';
    return '';
  }

  /** 
   * Safely unwraps a nested Music Assistant item into a plain object. 
   */
  private unwrapMediaItem(raw: any): any {
    if (!raw || typeof raw !== 'object') return raw;
    return raw.media_item ?? raw.media ?? raw.item ?? raw.payload ?? raw;
  }

  /**
   * Returns an empty favorites response structure.
   */
  private buildEmptyFavorites(zoneId: number, offset: number): FavoriteResponse {
    return {
      id: String(zoneId),
      name: 'Favorites',
      start: offset,
      totalitems: 0,
      items: [],
      ts: Date.now(),
    };
  }

  /**
   * Getter for cached favorites.
   * Allows external components (like the backend audio handler)
   * to quickly retrieve the last known favorites list for a zone.
   */
  getCachedFavorites(zoneId: number): FavoriteItem[] | undefined {
    return this.favoritesCache.get(zoneId);
  }
}

export default FavoritesController;