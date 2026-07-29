/**
 * Projects a zone's favourites and recently-played onto the public API contract.
 *
 * Both stores carry fields shaped for the Loxone clients — a favourite's `slot` and
 * `plus` describe a position in their button grid, and a recent item gets a `tag`,
 * `contentType` and numeric `type` so their strict schema accepts it. None of that says
 * anything about the favourite or the track, so none of it is reported here.
 */
import type { ApiFavorite, ApiFavorites, ApiRecentItem, ApiRecents } from '@/domain/zones/apiTypes';
import type { FavoriteItem } from '@/application/zones/favorites/types';
import type { RecentItem } from '@/application/zones/recents/recentsStore';

function toFavorite(item: FavoriteItem): ApiFavorite {
  return {
    id: item.id,
    name: item.name || item.title || '',
    source: item.audiopath ?? '',
    coverUrl: item.coverurl ?? '',
  };
}

export function toApiFavorites(
  zoneId: number,
  raw: { items: FavoriteItem[]; start: number; totalitems: number },
): ApiFavorites {
  return {
    zoneId,
    items: raw.items.map(toFavorite),
    start: raw.start,
    total: raw.totalitems,
  };
}

function toRecent(item: RecentItem): ApiRecentItem {
  return {
    source: item.audiopath ?? '',
    title: item.title || item.name || '',
    artist: item.artist ?? '',
    album: item.album ?? '',
    coverUrl: item.coverurl ?? '',
    // 'library' is how the store spells "not from a service"; say nothing instead.
    service: item.service && item.service !== 'library' ? item.service : '',
  };
}

export function toApiRecents(
  zoneId: number,
  raw: { items: RecentItem[] },
  start: number,
  limit: number,
): ApiRecents {
  const from = Math.max(0, start);
  return {
    zoneId,
    items: raw.items.slice(from, from + Math.max(0, limit)).map(toRecent),
    start: from,
    total: raw.items.length,
  };
}
