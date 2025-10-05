import {
  MediaProvider,
  RadioEntry,
  RadioFolderResponse,
  PlaylistResponse,
  RadioFolderItem,
  MediaFolderResponse,
  MediaFolderItem,
} from '../types';
import { MusicAssistantRadioService } from './radioService';
import { MusicAssistantPlaylistService } from './playlistService';
import { createProviderClient, MusicAssistantProviderClient } from './providerClient';
import { MusicAssistantLibraryService } from './libraryService';

const MEDIA_LIBRARY_ROOT_ITEMS: MediaFolderResponse['items'] = [
  {
    id: 'albums',
    name: 'Albums',
    cmd: 'albums',
    type: 1,
    contentType: 'Folder',
    sort: 'alpha',
  },
  {
    id: 'artists',
    name: 'Artists',
    cmd: 'artists',
    type: 1,
    contentType: 'Folder',
    sort: 'alpha',
  },
  {
    id: 'tracks',
    name: 'Tracks',
    cmd: 'tracks',
    type: 1,
    contentType: 'Folder',
    sort: 'alpha',
  },
];

/**
 * MusicAssistantProvider – bridges the Loxone media contract to a Music Assistant server.
 * It wraps dedicated radio, playlist, and library services so every API call is proxied
 * to Music Assistant while keeping the same MediaProvider interface.
 */
export class MusicAssistantProvider implements MediaProvider {
  private readonly radioService: MusicAssistantRadioService;
  private readonly playlistService: MusicAssistantPlaylistService;
  private readonly client: MusicAssistantProviderClient;
  private readonly libraryService: MusicAssistantLibraryService;

  /** Build the provider around a shared RPC client instance. */
  constructor(client: MusicAssistantProviderClient = createProviderClient()) {
    this.client = client;
    this.radioService = new MusicAssistantRadioService(this.client);
    this.playlistService = new MusicAssistantPlaylistService(this.client);
    this.libraryService = new MusicAssistantLibraryService(this.client);
  }

  /** Relay radio root metadata and presets from Music Assistant. */
  getRadios(): Promise<RadioEntry[]> | RadioEntry[] {
    return this.radioService.getRadios();
  }

  /**
   * Resolve a service folder either from the Music Assistant library or, when nothing matches,
   * fall back to the radio hierarchy to emulate the original Loxone layout.
   */
  async getServiceFolder(
    service: string,
    folderId: string,
    user: string,
    offset: number,
    limit: number,
  ): Promise<RadioFolderResponse | MediaFolderResponse> {
    const alias = this.libraryService.resolveFolderAlias(folderId);
    const normalizedFolder = alias.trim();
    const isRoot = normalizedFolder === '' || normalizedFolder === 'start' || normalizedFolder === 'root';

    if (!isRoot) {
      const mediaFolder = await this.libraryService.getServiceFolder(service, alias, user, offset, limit);
      if (mediaFolder) {
        return { ...mediaFolder, id: folderId };
      }
    }

    return this.radioService.getServiceFolder(service, normalizedFolder || 'start', user, offset, limit);
  }

  /** Lookup a concrete radio station by id. */
  resolveStation(service: string, stationId: string): RadioFolderItem | undefined {
    return this.radioService.resolveStation(service, stationId);
  }

  /** Page through playlists exposed by Music Assistant. */
  async getPlaylists(offset: number, limit: number): Promise<PlaylistResponse> {
    const { items, total } = await this.playlistService.getPlaylists(offset, limit);

    return {
      id: 0,
      name: 'Music Assistant',
      totalitems: total,
      start: offset,
      items,
    };
  }

  /** Resolve a playlist payload so we can forward the audiopath back to the zone. */
  resolvePlaylist(service: string, playlistId: string) {
    return this.playlistService.resolvePlaylist ? this.playlistService.resolvePlaylist(playlistId) : undefined;
  }

  /**
   * Navigate the Music Assistant media library, returning curated root folders when a lookup
   * is performed on the logical root.
   */
  async getMediaFolder(folderId: string, offset: number, limit: number): Promise<MediaFolderResponse> {
    const alias = this.libraryService.resolveFolderAlias(folderId);
    const normalized = alias.trim().toLowerCase();
    const isRoot = normalized === '' || normalized === 'root' || normalized === 'start' || normalized === '0';

    if (!isRoot) {
      return this.libraryService.getFolder(alias, offset, limit);
    }

    const items = MEDIA_LIBRARY_ROOT_ITEMS.slice(offset, offset + limit);
    return {
      id: folderId,
      totalitems: MEDIA_LIBRARY_ROOT_ITEMS.length,
      start: offset,
      items,
    };
  }

  /** Resolve a single media item (track/album/etc.) for playback. */
  resolveMediaItem(folderId: string, itemId: string): Promise<MediaFolderItem | undefined> | MediaFolderItem | undefined {
    const alias = this.libraryService.resolveFolderAlias(folderId);
    return this.libraryService.resolveItem(alias, itemId);
  }
}

export default MusicAssistantProvider;
