// src/model/adapters/musicAssistant/provider/musicAssistantContentProvider.ts
import { MusicAssistantApi } from '../api';
import logger from '@/utils/troxorLogger';
import type { RecentItem, ServiceFolderResponse } from '@/core/types/content';
import { mapFolderResponse, mapDetailResponse } from './mappers/folderMapper';
import { mapRecentlyPlayedItem } from './mappers/contentMapper';
import type { Track } from '../types/musicAssistantTypes';
import { getAvailableServices, getServices } from './facades/spotifyFacade';
import { decodeAudiopath } from '@/core/loxone/mediaMapping';
import { detectMediaType } from '../utils/detectMediaType';
import { performSearch } from './utils/globalSearch';
import { resolveItem } from './utils/resolveItem';

/**
 * -----------------------------------------------------------------------------
 * MusicAssistantContentProvider
 * -----------------------------------------------------------------------------
 * Acts as a high-level abstraction layer between the Loxone runtime
 * and the Music Assistant backend API. It provides:
 *  - Service folder browsing (albums, artists, playlists, radios)
 *  - Detailed views for items (album, playlist, artist)
 *  - Recently played items
 *  - Static Spotify-compatible façade for Loxone discovery
 *
 * All provider-specific logic is isolated here. Mapping and transformation
 * logic is delegated to the dedicated mapper modules.
 * -----------------------------------------------------------------------------
 */

interface ProviderInit {
  providerId: string;
  ip: string;
  port?: number;
}

type FolderType = 'album' | 'playlist' | 'artist' | 'radio';
type DetailType = Exclude<FolderType, 'radio'>;

/**
 * Static folder routing table for compatibility with Loxone’s folder structure.
 */
const FOLDER_MAP = [
  { match: ['start'], service: 'local', mode: 'root', type: 'radio' as const },
  { match: ['5', 'albums'], service: 'spotify', mode: 'root', type: 'album' as const },
  { match: ['3', 'playlists'], service: 'spotify', mode: 'root', type: 'playlist' as const },
  { match: ['6', 'artists'], service: 'spotify', mode: 'root', type: 'artist' as const },
  { match: ['4'], service: 'spotify', mode: 'detail', type: 'playlist' as const, detailId: '1' },
] as const;

export class MusicAssistantContentProvider {
  private readonly api: MusicAssistantApi;

  constructor(init: ProviderInit) {
    this.api = MusicAssistantApi.acquire(init.ip, init.port ?? 8095);
  }

  /**
   * Establishes a WebSocket connection to the Music Assistant backend.
   */
  async initialize(): Promise<void> {
    await this.api.connect();
  }

  /**
   * Releases the underlying Music Assistant API instance.
   */
  async dispose(): Promise<void> {
    this.api.release();
  }

  /* -------------------------------------------------------------------------- */
  /* Spotify façade for Loxone (static metadata)                                */
  /* -------------------------------------------------------------------------- */

  async getAvailableServices() {
    return getAvailableServices();
  }

  async getServices() {
    return getServices();
  }

  async globalSearch(source: string, query: string, unique: string) {
    return performSearch(this.api, source, query, unique);
  }

  async resolveItem(audiopath: string): Promise<any | undefined> {
    return resolveItem(this.api, audiopath);
  }

  /* -------------------------------------------------------------------------- */
  /* Folder router (root/detail)                                                */
  /* -------------------------------------------------------------------------- */

  /**
   * Resolves any folder or detail request based on Loxone's `serviceplay` path.
   * Internally routes to the correct folder or detail method.
   */
  async getServiceFolder(
    service: string,
    user: string,
    orgFolderId: string,
    offset = 0,
    limit = 50,
  ): Promise<ServiceFolderResponse> {
    const folderId = decodeAudiopath(orgFolderId);
    const mediaType = detectMediaType(folderId);

    logger.debug(
      `[MusicAssistantContentProvider] getServiceFolder → service=${service}, user=${user}, folder=${folderId}`,
    );

    // Static routes (Spotify emulation for Loxone UI)
    for (const route of FOLDER_MAP) {
      if (this.matchesFolder(folderId, route.match) && route.service === service) {
        return route.mode === 'root'
          ? this.getFolder(route.type, offset, limit)
          : this.getDetail(route.type as DetailType, route.detailId!, offset, limit);
      }
    }
    switch (mediaType) {
      case 'album':
      case 'playlist':
      case 'artist':
        return this.getDetail(mediaType as 'album' | 'playlist' | 'artist', folderId, offset, limit);
      default:
        return this.emptyResponse(folderId, 'Unknown', offset);
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Folder views                                                               */
  /* -------------------------------------------------------------------------- */

  /**
   * Fetches and maps a folder view (albums, playlists, artists, radios).
   */
  async getFolder(type: FolderType, offset = 0, limit = 50): Promise<ServiceFolderResponse> {
    try {
      const res = await this.fetchFolder(type, offset, limit);
      return mapFolderResponse(type, res.items, offset);
    } catch (err) {
      logger.warn(`[MusicAssistantContentProvider] Folder fetch failed: ${String(err)}`);
      return this.emptyResponse(type, type, offset);
    }
  }

  /**
   * Fetches and maps a detailed view for an album, playlist, or artist.
   * Includes metadata and contained tracks.
   */
  async getDetail(
    type: DetailType,
    id: string,
    offset = 0,
    limit = 50,
  ): Promise<ServiceFolderResponse> {
    try {
      const normalizedId = this.normalizeId(id);
      const [info, tracksResult] = await this.fetchDetail(type, normalizedId, offset, limit);

      const tracks: Track[] = Array.isArray(tracksResult)
        ? tracksResult
        : (tracksResult.items ?? []) as Track[];

      return mapDetailResponse(type, info, tracks, offset);
    } catch (err) {
      logger.warn(`[MusicAssistantContentProvider] Failed to load ${type} detail (${id}): ${String(err)}`);
      return this.emptyResponse(id, type, offset);
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Recently Played                                                            */
  /* -------------------------------------------------------------------------- */

  /**
   * Returns the user's recently played items as a Loxone-compatible folder.
   */
  async getRecentlyPlayed(zoneId: number, limit = 50): Promise<{ items: RecentItem[]; ts: number }> {
    logger.debug(`[MusicAssistantContentProvider] getRecentlyPlayed(zone=${zoneId}, limit=${limit})`);
    try {
      const { items } = await this.api.getRecentlyPlayed(limit, 0);
      const mapped: RecentItem[] = (Array.isArray(items) ? items : []).map((obj) =>
        mapRecentlyPlayedItem(obj),
      );

      return {
        items: mapped,
        ts: Math.floor(Date.now() / 1000),
      };
    } catch (err) {
      logger.warn(`[MusicAssistantContentProvider] getRecentlyPlayed failed: ${String(err)}`);
      return {
        items: [],
        ts: Math.floor(Date.now() / 1000),
      };
    }
  }

  /**
   * Clears the backend's recently played list.
   */
  async clearRecentlyPlayed(_zoneId?: number): Promise<void> {
    try {
      await this.api.clearRecentlyPlayed();
      logger.debug('[MusicAssistantContentProvider] Cleared recently played');
    } catch (err) {
      logger.warn(`[MusicAssistantContentProvider] clearRecentlyPlayed failed: ${String(err)}`);
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Private utilities                                                          */
  /* -------------------------------------------------------------------------- */

  private async fetchFolder(type: FolderType, offset: number, limit: number) {
    const f = {
      album: () => this.api.getLibraryAlbums(limit, offset),
      playlist: () => this.api.getLibraryPlaylists(limit, offset),
      artist: () => this.api.getLibraryArtists(limit, offset),
      radio: () => this.api.getLibraryRadios(limit, offset),
    } as const;
    return f[type]();
  }

  private async fetchDetail(type: DetailType, id: string, offset: number, limit: number) {
    const f = {
      album: () => Promise.all([
        this.api.getAlbum('library', id),
        this.api.getAlbumTracks('library', id, offset, limit),
      ]),
      playlist: () => Promise.all([
        this.api.getPlaylist('library', id),
        this.api.getPlaylistTracks(id, 'library'),
      ]),
      artist: () => Promise.all([
        this.api.getArtist('library', id),
        this.api.getArtistTracks('library', id, offset, limit),
      ]),
    } as const;
    return f[type]();
  }

  /**
   * Normalizes incoming IDs to raw Music Assistant IDs.
   * Removes prefixes like `library://` or `spotify@`.
   */
  private normalizeId(id: string): string {
    return id
      .replace(/^library:\/\/(album|playlist|artist|track)\//, '')
      .replace(/^spotify@[^:]+:(album|playlist|artist|track):/, '')
      .trim();
  }

  /**
   * Determines whether a folder ID matches a known alias (used in static routes).
   */
  private matchesFolder(folderId: string, aliases: readonly string[]): boolean {
    const id = decodeURIComponent(folderId ?? '')
      .toLowerCase()
      .replace(/^spotify\/nouser\//, '')
      .trim();
    return aliases.includes(id);
  }

  /**
   * Returns a minimal, valid `ServiceFolderResponse` with zero items.
   */
  private emptyResponse(id: string, name: string, start = 0): ServiceFolderResponse {
    return { id, name, service: 'musicassistant', start, totalitems: 0, items: [] };
  }
}