import logger from '@/utils/troxorLogger';
import type { MusicAssistantApi } from '../../api';
import type { Track, Album, Artist, Playlist } from '../../types/musicAssistantTypes';
import { mapMediaItem } from '../mappers/contentMapper';
import type { ServiceFolderItem } from '@/core/types/content';

/**
 * -----------------------------------------------------------------------------
 * Music Assistant Global Search
 * -----------------------------------------------------------------------------
 * Provides a static search description and a search executor (performSearch).
 * -----------------------------------------------------------------------------
 */

/**
 * Returns a static folder describing the available search groups.
 * Used by Loxone to render the "Search" root folder.
 */
export function globalSearchDescribe() {
  return {
    id: 'globalSearch',
    name: 'Search',
    service: 'musicassistant',
    start: 0,
    totalitems: 4,
    items: [
      { id: 'search:tracks', name: 'Tracks', title: 'Tracks', service: 'musicassistant', tag: 'track', type: 7 },
      { id: 'search:albums', name: 'Albums', title: 'Albums', service: 'musicassistant', tag: 'album', type: 7 },
      { id: 'search:artists', name: 'Artists', title: 'Artists', service: 'musicassistant', tag: 'artist', type: 7 },
      { id: 'search:playlists', name: 'Playlists', title: 'Playlists', service: 'musicassistant', tag: 'playlist', type: 7 },
    ],
  };
}

/**
 * Performs the actual search via the Music Assistant API.
 * Returns mapped results per category.
 */
export async function performSearch(
  api: MusicAssistantApi,
  source: string,
  query: string,
  unique: string,
): Promise<{ error: number; result: Record<string, ServiceFolderItem[]>; message?: string }> {
  logger.debug(`[MusicAssistantSearch] source="${source}" query="${query}" unique=${unique}`);

  const limits: Record<string, number> = {};
  const filterPart = source.split(':')[1] ?? '';
  for (const entry of filterPart.split(',')) {
    const [type, rawLimit] = entry.split('#');
    if (type) {
      limits[type.trim().toLowerCase()] = Number(rawLimit) || 5;
    }
  }
  const limit = Math.max(...Object.values(limits), 10);

  try {
    const result = await api.search(query, limit);
    const raw = result?.result ?? result ?? {};
    const mapped: Record<string, ServiceFolderItem[]> = {};

    if (Array.isArray(raw.tracks)) {
      mapped.tracks = (raw.tracks as Track[]).map(t => mapMediaItem(t, 'track'));
    }
    if (Array.isArray(raw.albums)) {
      mapped.albums = (raw.albums as Album[]).map(a => mapMediaItem(a, 'album'));
    }
    if (Array.isArray(raw.artists)) {
      mapped.artists = (raw.artists as Artist[]).map(a => mapMediaItem(a, 'artist'));
    }
    if (Array.isArray(raw.playlists)) {
      mapped.playlists = (raw.playlists as Playlist[]).map(p => mapMediaItem(p, 'playlist'));
    }

    return { error: 0, result: mapped };
  } catch (err) {
    logger.warn(`[MusicAssistantSearch] failed for "${query}": ${String(err)}`);
    return { error: 1, result: {}, message: String(err) };
  }
}