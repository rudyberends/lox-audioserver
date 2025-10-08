import logger from '../../../utils/troxorlogger';
import { FileType } from '../../zone/loxoneTypes';
import MusicAssistantProviderClient from './client';
import RadioController from './radio';
import PlaylistController from './playlist';
import LibraryController from './library';
import {
  parsePort,
} from './utils';
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
} from '../types';

const ROOT_FOLDER_ID = '0';
const DEFAULT_PROVIDER_LABEL = 'Music Assistant';
const DEFAULT_RADIO_SERVICE = 'musicassistant';
const CACHE_TTL_MS = 30_000;

// We are faking a NAS origin for all our Music Assistant library items
// This way Loxone will show it under Shared Network Drives instead of SD Card
const LOCAL_LIBRARY_ORIGIN_NAS = 1;

const MEDIA_LIBRARY_ROOT_ITEMS: MediaFolderItem[] = [
  createRootFolderItem('albums', 'Albums'),
  createRootFolderItem('artists', 'Artists'),
  createRootFolderItem('tracks', 'Tracks'),
];

/**
 * Music Assistant media provider backed by the Music Assistant websocket API.
 * Bridges library, playlist, and radio browsing into the Loxone AudioServer schema.
 */
export class MusicAssistantProvider implements MediaProvider {
  private readonly host?: string;
  private readonly port: number;
  private client?: MusicAssistantProviderClient;

  private readonly radioController: RadioController;
  private readonly playlistController: PlaylistController;
  private readonly libraryController: LibraryController;

  constructor() {
    const host =
      (process.env.MEDIA_PROVIDER_IP ?? process.env.MUSIC_ASSISTANT_HOST ?? '').trim() ||
      (process.env.MUSICASSISTANT_IP ?? '').trim();
    const port = parsePort(process.env.MEDIA_PROVIDER_PORT, 8095);

    this.host = host || undefined;
    this.port = port;

    if (this.host) {
      this.client = new MusicAssistantProviderClient(this.host, this.port);
      setMusicAssistantBaseUrl(this.host, this.port);
      logger.info(`[MusicAssistantProvider] Configured with host ${this.host}:${this.port}`);
    } else {
      logger.warn('[MusicAssistantProvider] MEDIA_PROVIDER_IP not set. Provider will stay inactive.');
      this.client = undefined;
    }

    const clientResolver = () => this.getClient();
    this.radioController = new RadioController(
      clientResolver,
      DEFAULT_RADIO_SERVICE,
      CACHE_TTL_MS,
      DEFAULT_PROVIDER_LABEL,
    );
    this.playlistController = new PlaylistController(
      clientResolver,
      DEFAULT_RADIO_SERVICE,
      DEFAULT_PROVIDER_LABEL,
    );
    this.libraryController = new LibraryController(
      clientResolver,
      DEFAULT_RADIO_SERVICE,
      ROOT_FOLDER_ID,
      MEDIA_LIBRARY_ROOT_ITEMS,
    );
  }

  getRadios(): Promise<RadioEntry[]> | RadioEntry[] {
    return this.radioController.getRadios();
  }

  getServiceFolder(
    service: string,
    folderId: string,
    _user: string,
    offset: number,
    limit: number,
  ): Promise<RadioFolderResponse> | RadioFolderResponse {
    return this.radioController.getServiceFolder(service, folderId, offset, limit);
  }

  resolveStation(
    _service: string,
    stationId: string,
  ): Promise<RadioFolderItem | undefined> | RadioFolderItem | undefined {
    return this.radioController.resolveStation(stationId);
  }

  getPlaylists(offset: number, limit: number): Promise<PlaylistResponse> | PlaylistResponse {
    return this.playlistController.getPlaylists(offset, limit);
  }

  getPlaylistItems(
    playlistId: string,
    offset: number,
    limit: number,
  ): Promise<PlaylistResponse | undefined> | PlaylistResponse | undefined {
    return this.playlistController.getPlaylistItems(playlistId, offset, limit);
  }

  resolvePlaylist(
    _service: string,
    playlistId: string,
  ): Promise<PlaylistItem | undefined> | PlaylistItem | undefined {
    return this.playlistController.resolvePlaylist(playlistId);
  }

  getMediaFolder(
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<MediaFolderResponse> | MediaFolderResponse {
    return this.libraryController.getMediaFolder(folderId, offset, limit);
  }

  resolveMediaItem(
    folderId: string,
    itemId: string,
  ): Promise<MediaFolderItem | undefined> | MediaFolderItem | undefined {
    return this.libraryController.resolveMediaItem(folderId, itemId);
  }

  private getClient(): MusicAssistantProviderClient | undefined {
    if (!this.client) {
      logger.debug('[MusicAssistantProvider] Client unavailable.');
    }
    return this.client;
  }
}

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
