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
import { BeolinkRadioService } from './radioService';

const DEFAULT_HOST = process.env.MEDIA_PROVIDER_IP || process.env.BEOLINK_HOST || '127.0.0.1';
const DEFAULT_TTL_SECONDS = Number(process.env.MEDIA_PROVIDER_CACHE_TTL || 30) || 30;
const DEFAULT_FAVORITES_NAME = process.env.BEOLINK_FAVORITES_NAME || 'Beolink Favorites';
const DEFAULT_ICON_PROXY = process.env.RADIO_ICON_PROXY || 'beolink';

/**
 * Beolink provider that currently exposes radio favorites while returning
 * empty collections for playlist/media APIs.
 */
export class BeolinkProvider implements MediaProvider {
  private readonly radioService: BeolinkRadioService;

  constructor() {
    this.radioService = new BeolinkRadioService({
      host: DEFAULT_HOST,
      ttlSeconds: DEFAULT_TTL_SECONDS,
      favoritesName: DEFAULT_FAVORITES_NAME,
      iconProxyId: DEFAULT_ICON_PROXY,
    });
  }

  getRadios(): Promise<RadioEntry[]> | RadioEntry[] {
    return this.radioService.getRadios();
  }

  getServiceFolder(
    service: string,
    folderId: string,
    user: string,
    offset: number,
    limit: number,
  ): Promise<RadioFolderResponse> {
    return this.radioService.getServiceFolder(service, folderId, user, offset, limit);
  }

  resolveStation(
    service: string,
    stationId: string,
  ): Promise<RadioFolderItem | undefined> | RadioFolderItem | undefined {
    return this.radioService.resolveStation(service, stationId);
  }

  getPlaylists(offset: number, _limit: number): PlaylistResponse {
    return {
      id: 0,
      name: 'Beolink Playlists',
      totalitems: 0,
      start: offset,
      items: [],
    };
  }

  resolvePlaylist(
    _service: string,
    _playlistId: string,
  ): Promise<PlaylistItem | undefined> | PlaylistItem | undefined {
    return undefined;
  }

  getMediaFolder(
    folderId: string,
    offset: number,
    _limit: number,
  ): Promise<MediaFolderResponse> | MediaFolderResponse {
    return {
      id: folderId,
      totalitems: 0,
      start: offset,
      items: [],
    };
  }

  resolveMediaItem(
    _folderId: string,
    _itemId: string,
  ): Promise<MediaFolderItem | undefined> | MediaFolderItem | undefined {
    return undefined;
  }
}

export default BeolinkProvider;

