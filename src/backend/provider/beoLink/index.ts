import logger from '../../../utils/troxorlogger';
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

/**
 * Beolink provider that currently exposes radio favorites while returning
 * empty collections for playlist/media APIs.
 */
export class BeolinkProvider implements MediaProvider {
  private readonly host: string;
  private readonly ttlSeconds: number;
  private readonly favoritesName: string;
  private readonly iconProxyId: string;
  private readonly providerLabel: string;
  private readonly serviceId: string;
  private readonly radioService: BeolinkRadioService;

  constructor() {
    const rawHost = (process.env.MEDIA_PROVIDER_IP || process.env.BEOLINK_HOST || '').trim();
    this.host = rawHost || '127.0.0.1';

    if (rawHost) {
      logger.info(`[BeolinkProvider] Configured with host ${this.host}`);
    } else {
      logger.warn(`[BeolinkProvider] MEDIA_PROVIDER_IP not set. Falling back to ${this.host}`);
    }

    this.ttlSeconds = Number(process.env.MEDIA_PROVIDER_CACHE_TTL || 30) || 30;

    const resolvedFavoritesName = (process.env.BEOLINK_FAVORITES_NAME || 'Beolink Favorites').trim();
    this.favoritesName = resolvedFavoritesName || 'Beolink Favorites';

    const resolvedIconProxy = (process.env.RADIO_ICON_PROXY || 'beolink').trim();
    this.iconProxyId = resolvedIconProxy || 'beolink';

    const providerLabelEnv = (process.env.BEOLINK_PROVIDER_LABEL || '').trim();
    const derivedLabel = this.favoritesName.replace(/\s+Favorites$/i, '');
    this.providerLabel = providerLabelEnv || derivedLabel || 'Beolink';

    const serviceIdEnv = (process.env.BEOLINK_SERVICE_ID || 'beolink').trim();
    this.serviceId = serviceIdEnv || 'beolink';

    this.radioService = new BeolinkRadioService({
      host: this.host,
      ttlSeconds: this.ttlSeconds,
      favoritesName: this.favoritesName,
      iconProxyId: this.iconProxyId,
      providerLabel: this.providerLabel,
      serviceId: this.serviceId,
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
