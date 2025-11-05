import logger from '@/utils/troxorLogger';
import type { MusicAssistantApi } from '../../api';
import type { Track, Album, Artist, Playlist, Radio } from '../../types/musicAssistantTypes';
import { mapMediaItem } from '../mappers/contentMapper';
import type { ServiceFolderItem } from '@/core/types/content';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

interface SearchResponse {
  error: number;
  result: Record<string, ServiceFolderItem[]>;
  message?: string;
}

/* -------------------------------------------------------------------------- */
/* Static descriptor                                                          */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* performSearch                                                              */
/* -------------------------------------------------------------------------- */

export async function performSearch(
  api: MusicAssistantApi,
  source: string,
  query: string,
  unique: string,
): Promise<SearchResponse> {
  logger.info(`[MusicAssistantSearch] source="${source}" query="${query}" unique=${unique}`);

  const limits: Record<string, number> = {};
  const filterPart = source.split(':')[1] ?? '';
  for (const entry of filterPart.split(',')) {
    const [type, rawLimit] = entry.split('#');
    if (type) {
      limits[type.trim().toLowerCase()] = Number(rawLimit) || 5;
    }
  }
  const limit = Math.min(Math.max(...Object.values(limits), 5), 10);

  /* ------------------------------------------------------------------------ */
  /* Radio search (TuneIn only)                                               */
  /* ------------------------------------------------------------------------ */
  if (source.toLowerCase().startsWith('tunein')) {
    try {
      const result = await api.searchRadios(query, limit);
      const radios = (result?.result ?? result ?? []) as Radio[];

      return {
        error: 0,
        result: {
          station: radios.map(r => mapMediaItem(r, 'radio')),
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[MusicAssistantSearch] Radio search failed for "${query}": ${msg}`);
      return { error: 1, result: {}, message: msg };
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Default: standard music search                                           */
  /* ------------------------------------------------------------------------ */
  try {
    const result = await api.search(query, limit);
    const raw = (result?.result ?? result ?? {}) as {
      tracks?: Track[];
      albums?: Album[];
      artists?: Artist[];
      playlists?: Playlist[];
    };

    const mapped: Record<string, ServiceFolderItem[]> = {};
    if (Array.isArray(raw.tracks)) {
      mapped.tracks = raw.tracks.map(t => mapMediaItem(t, 'track'));
    }
    if (Array.isArray(raw.albums)) {
      mapped.albums = raw.albums.map(a => mapMediaItem(a, 'album'));
    }
    if (Array.isArray(raw.artists)) {
      mapped.artists = raw.artists.map(a => mapMediaItem(a, 'artist'));
    }
    if (Array.isArray(raw.playlists)) {
      mapped.playlists = raw.playlists.map(p => mapMediaItem(p, 'playlist'));
    }

    return { error: 0, result: mapped };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[MusicAssistantSearch] Music search failed for "${query}": ${msg}`);
    return { error: 1, result: {}, message: msg };
  }
}