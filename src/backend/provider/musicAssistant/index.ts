import logger from '../../../utils/troxorlogger';
import { FileType } from '../../zone/loxoneTypes';
import MusicAssistantProviderClient from './client';
import RadioController from './radio';
import PlaylistController from './playlist';
import LibraryController from './library';
import FavoritesController from './favorites';
import RecentController from './recent';
import SearchController from './search';
import { parsePort } from './utils';
import { setMusicAssistantBaseUrl } from './mappers';
import {
  MediaFolderItem,
  MediaFolderResponse,
  MediaProvider,
  PlaylistItem,
  PlaylistResponse,
  RadioEntry,
  RadioFolderItem,
  RadioFolderResponse,
  FavoriteResponse,
  RecentResponse,
} from '../types';

const ROOT_FOLDER_ID = '0';
const DEFAULT_PROVIDER_LABEL = 'Music Assistant';
const DEFAULT_SERVICE = 'musicassistant';
const CACHE_TTL_MS = 30_000;

// We are faking a NAS origin for all Music Assistant library items.
// This ensures Loxone lists them under "Shared Network Drives" instead of "SD Card".
const LOCAL_LIBRARY_ORIGIN_NAS = 1;

const MEDIA_LIBRARY_ROOT_ITEMS: MediaFolderItem[] = [
  createRootFolderItem('albums', 'Albums'),
  createRootFolderItem('artists', 'Artists'),
  createRootFolderItem('tracks', 'Tracks'),
];

/**
 * MusicAssistantProvider
 * ----------------------
 * Acts as a bridge between the Music Assistant WebSocket API and
 * the Loxone AudioServer media provider system.
 *
 * This provider exposes Music Assistant’s media collections
 * (library, playlists, radios, favorites, recents)
 * to the Loxone AudioServer using its internal schema.
 *
 * Responsibilities:
 * - Initialize and manage the Music Assistant WebSocket client.
 * - Delegate specific requests to domain controllers:
 *   - RadioController
 *   - PlaylistController
 *   - LibraryController
 *   - FavoritesController
 *   - RecentController
 * - Normalize data structures for Loxone’s AudioServer protocol.
 */
export class MusicAssistantProvider implements MediaProvider {
  /** Music Assistant host address */
  private readonly host?: string;

  /** WebSocket or API port (default 8095) */
  private readonly port: number;

  /** Music Assistant WebSocket client instance */
  private client?: MusicAssistantProviderClient;

  /** Controller instances for handling subdomains of media content */
  private readonly radioController: RadioController;
  private readonly playlistController: PlaylistController;
  private readonly libraryController: LibraryController;
  private readonly favoritesController: FavoritesController;
  private readonly recentController: RecentController;
  private readonly searchController: SearchController;

  /**
   * Initializes a MusicAssistantProvider instance.
   *
   * Environment variables used:
   * - MEDIA_PROVIDER_IP
   * - MEDIA_PROVIDER_PORT (default: 8095)
   *
   * The provider sets up controller modules for each content type.
   */
  constructor() {
    const host = (process.env.MEDIA_PROVIDER_IP ?? '').trim();
    const port = parsePort(process.env.MEDIA_PROVIDER_PORT, 8095);

    this.host = host || undefined;
    this.port = port;

    // Initialize client connection
    if (this.host) {
      this.client = new MusicAssistantProviderClient(this.host, this.port);
      setMusicAssistantBaseUrl(this.host, this.port);
      logger.info(`[MusicAssistantProvider] Configured with host ${this.host}:${this.port}`);
    } else {
      logger.warn('[MusicAssistantProvider] MEDIA_PROVIDER_IP not set. Provider will remain inactive.');
      this.client = undefined;
    }

    // Resolve client reference lazily for controllers
    const clientResolver = () => this.getClient();

    // Initialize feature controllers
    this.radioController = new RadioController(clientResolver, DEFAULT_SERVICE, CACHE_TTL_MS, DEFAULT_PROVIDER_LABEL);
    this.playlistController = new PlaylistController(clientResolver, DEFAULT_SERVICE, DEFAULT_PROVIDER_LABEL);
    this.libraryController = new LibraryController(clientResolver, DEFAULT_SERVICE, ROOT_FOLDER_ID, MEDIA_LIBRARY_ROOT_ITEMS);
    this.favoritesController = new FavoritesController(clientResolver, DEFAULT_SERVICE);
    this.recentController = new RecentController(clientResolver, DEFAULT_SERVICE);
    this.searchController = new SearchController(clientResolver);
  }

  /**
   * Fetch a flat list of all available radio stations.
   */
  getRadios(): Promise<RadioEntry[]> | RadioEntry[] {
    return this.radioController.getRadios();
  }

  /**
   * Fetch radio folders (categories) from the Music Assistant backend.
   */
  getServiceFolder(
    service: string,
    folderId: string,
    _user: string,
    offset: number,
    limit: number,
  ): Promise<RadioFolderResponse> | RadioFolderResponse {
    return this.radioController.getServiceFolder(service, folderId, offset, limit);
  }

  /**
   * Resolve a radio station by ID into a playable item.
   */
  resolveStation(
    _service: string,
    stationId: string,
  ): Promise<RadioFolderItem | undefined> | RadioFolderItem | undefined {
    return this.radioController.resolveStation(stationId);
  }

  /**
   * Retrieve all available playlists.
   */
  getPlaylists(offset: number, limit: number): Promise<PlaylistResponse> | PlaylistResponse {
    return this.playlistController.getPlaylists(offset, limit);
  }

  /**
   * Retrieve the items belonging to a specific playlist.
   */
  getPlaylistItems(
    playlistId: string,
    offset: number,
    limit: number,
  ): Promise<PlaylistResponse | undefined> | PlaylistResponse | undefined {
    return this.playlistController.getPlaylistItems(playlistId, offset, limit);
  }

  /**
   * Resolve a playlist by ID to get its metadata and content path.
   */
  resolvePlaylist(
    _service: string,
    playlistId: string,
  ): Promise<PlaylistItem | undefined> | PlaylistItem | undefined {
    return this.playlistController.resolvePlaylist(playlistId);
  }

  /**
   * Retrieve items from the Music Assistant library (albums, artists, tracks).
   */
  getMediaFolder(
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<MediaFolderResponse> | MediaFolderResponse {
    return this.libraryController.getMediaFolder(folderId, offset, limit);
  }

  /**
   * Resolve a specific media item (track, album, or artist) by its ID.
   */
  resolveMediaItem(
    folderId: string,
    itemId: string,
  ): Promise<MediaFolderItem | undefined> | MediaFolderItem | undefined {
    return this.libraryController.resolveMediaItem(folderId, itemId);
  }

  /**
   * Fetch and cache the list of user favorites for a given zone.
   */
  getFavorites(zoneId: number, offset: number, limit: number): Promise<FavoriteResponse> {
    return this.favoritesController.getFavorites(zoneId, offset, limit);
  }

  /**
   * Fetch recently played items.
   */
  getRecentlyPlayed(_zoneId: number, limit: number): Promise<RecentResponse> {
    return this.recentController.getRecentlyPlayed(limit);
  }

  /**
   * Clear recently played list.
   */
  async clearRecentlyPlayed(_zoneId: number): Promise<void> {
    await this.recentController.clearRecentlyPlayed();
  }

async globalSearch(source: string, query: string): Promise<Record<string, any>> {
  const results = await this.searchController.globalSearch(source, query);

  // Defensive fallback so the provider always returns a consistent shape
  return results ?? {};
}

  /**
   * Internal helper to lazily get the Music Assistant client instance.
   *
   * Logs a debug message when the client is not available.
   */
  private getClient(): MusicAssistantProviderClient | undefined {
    if (!this.client) {
      logger.debug('[MusicAssistantProvider] Client unavailable.');
    }
    return this.client;
  }
}

/**
 * Utility to create standardized media folder entries for library roots.
 *
 * @param folderKey - Identifier (e.g. "albums", "artists", "tracks").
 * @param displayName - Human-readable label.
 * @returns A `MediaFolderItem` ready for use in the library controller.
 */
function createRootFolderItem(folderKey: string, displayName: string): MediaFolderItem {
  return {
    id: folderKey,
    name: displayName,
    cmd: folderKey,
    type: FileType.Folder,
    contentType: 'Folder',
    sort: 'alpha',
    nas: true,
    origin: LOCAL_LIBRARY_ORIGIN_NAS,
  };
}

export default MusicAssistantProvider;