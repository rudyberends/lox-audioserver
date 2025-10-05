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

const DUMMY_RADIO_ITEMS: RadioFolderItem[] = [];

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
  getRadios(): RadioEntry[] {
    return [];
  }

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

  resolveStation(_service: string, stationId: string): RadioFolderItem | undefined {
    return DUMMY_RADIO_ITEMS.find((item) => item.id === stationId || item.audiopath === stationId);
  }

  getPlaylists(offset: number, _limit: number): PlaylistResponse {
    return { ...EMPTY_PLAYLIST_RESPONSE, start: offset };
  }

  resolvePlaylist(_service: string, _playlistId: string): PlaylistItem | undefined {
    return undefined;
  }

  getMediaFolder(folderId: string, offset: number, limit: number): MediaFolderResponse {
    return {
      id: folderId,
      totalitems: 0,
      start: offset,
      items: [],
    };
  }

  resolveMediaItem(_folderId: string, _itemId: string): MediaFolderItem | undefined {
    return undefined;
  }
}
