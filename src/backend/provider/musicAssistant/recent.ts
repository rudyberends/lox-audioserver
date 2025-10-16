import MusicAssistantProviderClient from './client';
import { RecentItem, RecentResponse } from '../types';
import {
  buildLibraryUri,
  buildPlaylistUri,
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
import { FileType } from '../../zone/loxoneTypes';

/**
 * RecentController
 * ----------------
 * This controller manages the "Recently Played" functionality of the
 * Music Assistant provider integration. It handles loading, clearing,
 * and mapping recent playback items into the Loxone-compatible schema.
 *
 * Responsibilities:
 * - Fetch the list of recently played items via the Music Assistant RPC API.
 * - Normalize raw API responses into `RecentItem` objects.
 * - Allow clearing of the recent items list.
 * - Provide empty fallback responses when no client or items exist.
 */
export class RecentController {
  /**
   * Constructor for RecentController.
   *
   * @param getClient - Function returning the active Music Assistant client (or undefined).
   * @param fallbackProvider - Default provider name used when item metadata lacks provider info.
   */
  constructor(
    private readonly getClient: () => MusicAssistantProviderClient | undefined,
    private readonly fallbackProvider: string,
  ) {}

  /**
   * Fetch and map the "Recently Played" items.
   *
   * @param limit - Maximum number of items to retrieve.
   * @returns A normalized `RecentResponse` containing recent media items.
   *
   * Behavior:
   * - Calls the Music Assistant RPC API to get recently played items.
   * - Maps each entry into a Loxone-compatible structure.
   * - Returns an empty response if no client is available or RPC fails.
   */
  async getRecentlyPlayed(limit: number): Promise<RecentResponse> {
    const client = this.getClient();
    if (!client) return this.buildEmptyRecent();

    try {
      const response = await client.rpc<any>('music/recently_played_items', { limit });
      const entries = Array.isArray(response?.items ?? response)
        ? response.items ?? response
        : [];

      // Map and normalize entries
      const mapped = entries
        .map((item: any) => this.mapRecentItem(item))
        .filter((x: any): x is RecentItem => x !== null);

      return {
        id: 'recentlyPlayed',
        name: 'Recently Played',
        start: 0,
        totalitems: mapped.length,
        items: mapped,
        ts: Date.now(),
      };
    } catch (error) {
      logError('music/recently_played_items', error);
      return this.buildEmptyRecent();
    }
  }

  /**
   * Clear the "Recently Played" list.
   *
   * Attempts two possible RPC endpoints for clearing, to ensure compatibility
   * across different versions of Music Assistant.
   *
   * @returns Promise<void>
   */
  async clearRecentlyPlayed(): Promise<void> {
    const client = this.getClient();
    if (!client) return;

    const commands = ['music/recently_played_items/clear', 'music/clear_recently_played'];
    for (const cmd of commands) {
      try {
        await client.rpc(cmd);
        return;
      } catch (err) {
        logError(cmd, err);
      }
    }
  }

  /**
   * Map a single raw Music Assistant item into a standardized `RecentItem` object.
   *
   * @param raw - Raw media item data returned by the Music Assistant API.
   * @returns A normalized `RecentItem` or `null` if invalid.
   *
   * Behavior:
   * - Detects the media type (track, album, playlist, radio, etc.).
   * - Builds a normalized Loxone-compatible `RecentItem`.
   * - Supports both audio and playlist types.
   */
  private mapRecentItem(raw: any): RecentItem | null {
  const item = raw?.media_item ?? raw?.media ?? raw?.item ?? raw?.payload ?? raw;
  if (!item) return null;

  const mediaType =
    item.media_type?.toLowerCase?.() ??
    item.type?.toLowerCase?.() ??
    item.category?.toLowerCase?.() ??
    '';
  const provider = extractProvider(item) ?? this.fallbackProvider;
  const cover = extractImage(item.image);

  if (mediaType === 'radio' || mediaType === 'station') {
    const stationUri = extractUri(item) ?? extractItemId(item) ?? '';
    if (!stationUri) return null;
    const station = normalizeMediaUri(stationUri);
    const title = extractName(item) ?? station;
    return {
      audiopath: station,
      coverurl: cover,
      title,
      name: title,
      station: title,
      contentType: 'Playlists',
      service: 'custom_stream',
      type: FileType.Playlist,
      provider,
    };
  }

  let uri = extractUri(item);
  if (!uri) {
    const rawId = extractItemId(item) ?? extractName(item) ?? '';
    if (mediaType === 'playlist') {
      uri = toPlaylistCommandUri(buildPlaylistUri(rawId, provider), provider, rawId);
    } else if (mediaType === 'album') {
      uri = buildLibraryUri('album', rawId, provider);
    } else if (mediaType === 'artist') {
      uri = buildLibraryUri('artist', rawId, provider);
    } else {
      uri = buildLibraryUri('track', rawId, provider);
    }
  }

  const audiopath = normalizeMediaUri(uri ?? '');
  if (!audiopath) return null;

  const title = extractName(item) ?? audiopath;
  const base: RecentItem = {
    audiopath,
    coverurl: cover,
    title,
    name: title,
    service: 'library',
    type: mediaType === 'playlist' ? FileType.Playlist : FileType.File,
    provider,
  };

  if (mediaType === 'playlist') return base;

  return {
    ...base,
    artist: extractArtist(item),
    album: extractAlbum(item),
    duration: safeNumber(item?.duration),
  };
}

  /**
   * Returns an empty placeholder RecentResponse when no data is available.
   *
   * @returns A `RecentResponse` with zero items.
   */
  private buildEmptyRecent(): RecentResponse {
    return {
      id: 'recentlyPlayed',
      name: 'Recently Played',
      start: 0,
      totalitems: 0,
      items: [],
      ts: Date.now(),
    };
  }
}

export default RecentController;