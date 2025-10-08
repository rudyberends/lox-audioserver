import {
  MediaProvider,
  RadioEntry,
  RadioFolderItem,
  RadioFolderResponse,
  PlaylistResponse,
  PlaylistItem,
  MediaFolderResponse,
  MediaFolderItem,
} from './types';

/**
 * Shared empty radio list used by every dummy endpoint.
 */
const DUMMY_RADIO_ITEMS: RadioFolderItem[] = [];

/**
 * Template response returned from {@link DummyProvider#getPlaylists}.
 */
const EMPTY_PLAYLIST_RESPONSE: PlaylistResponse = {
  id: 0,
  name: 'Dummy Playlists',
  totalitems: 0,
  start: 0,
  items: [],
};

/**
 * DummyProvider – fallback implementation used when no media provider is configured.
 * It keeps client flows working by returning empty collections for every endpoint.
 */
export class DummyProvider implements MediaProvider {
  /**
   * Returns an empty list because the dummy provider has no radio stations.
   */
  getRadios(): RadioEntry[] {
    return [];
  }

  /**
   * Always responds with an empty radio folder structure.
   */
  getServiceFolder(service: string, _folderId: string, _user: string, offset: number, limit: number): RadioFolderResponse {
    const items = DUMMY_RADIO_ITEMS.slice(offset, offset + limit);
    return {
      id: 'start',
      name: '/',
      service,
      totalitems: DUMMY_RADIO_ITEMS.length,
      start: offset,
      items,
    };
  }

  /**
   * Locates a radio entry within the shared empty array (always undefined).
   */
  resolveStation(_service: string, stationId: string): RadioFolderItem | undefined {
    return DUMMY_RADIO_ITEMS.find((item) => item.id === stationId || item.audiopath === stationId);
  }

  /**
   * Returns a playlist response with zero items.
   */
  getPlaylists(offset: number, _limit: number): PlaylistResponse {
    return { ...EMPTY_PLAYLIST_RESPONSE, start: offset };
  }

  /**
   * Playlist resolution always fails for the dummy provider.
   */
  resolvePlaylist(_service: string, _playlistId: string): PlaylistItem | undefined {
    return undefined;
  }

  /**
   * Returns an empty media folder for any requested path.
   */
  getMediaFolder(folderId: string, offset: number, limit: number): MediaFolderResponse {
    return {
      id: folderId,
      totalitems: 0,
      start: offset,
      items: [],
    };
  }

  /**
   * Always returns undefined because there are no media items to resolve.
   */
  resolveMediaItem(_folderId: string, _itemId: string): MediaFolderItem | undefined {
    return undefined;
  }
}
