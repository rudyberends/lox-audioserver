import logger from '@/utils/troxorLogger';
import { loadFavorites, saveFavorites } from '@/model/local/favorites/favoritesStore';
import type { FavoriteItem, FavoriteResponse } from '@/model/local/favorites/types';
import { providerRuntime } from '@/runtime/provider';
import { extractImageFromTrack } from '@/model/adapters/musicAssistant/utils/imageUtils';
import { FileType } from '@/core/types/loxone';
import { notifyRoomFavoritesChanged } from '@/http/loxoneHttp/websocketNotifier';

/** Mapping between logical favorite types and Loxone-compatible path prefixes */
const prefixMap: Record<string, string> = {
  tunein: 'tunein:station:s',
  spotify_playlist: 'spotify:playlist:',
  playlist: 'playlist:',
  spotify_artist: 'spotify:artist:',
  spotify_album: 'spotify:album:',
  spotify_track: 'spotify:track:',
};

/**
 * Detects the media type based on the `audiopath` string.
 * Uses simple pattern matching to map URIs like `library://album/...`
 * or `spotify:track:...` to the correct Loxone-compatible type.
 */
function detectType(audiopath: string): string {
  if (/tunein|radio/i.test(audiopath)) {
    return 'tunein';
  }
  if (/playlist/i.test(audiopath)) {
    return 'playlist';
  }
  if (/album/i.test(audiopath)) {
    return 'spotify_album';
  }
  if (/artist/i.test(audiopath)) {
    return 'spotify_artist';
  }
  if (/track/i.test(audiopath)) {
    return 'spotify_track';
  }
  return 'unknown';
}

/**
 * Saves the updated favorites list to disk and broadcasts the
 * `roomfavchanged_event` notification to all connected clients.
 */
async function persist(zoneId: number, items: FavoriteItem[]): Promise<FavoriteResponse> {
  const updated: FavoriteResponse = {
    id: zoneId,
    type: FileType.Favorite,
    start: 0,
    totalitems: items.length,
    items,
  };
  await saveFavorites(zoneId, updated);
  notifyRoomFavoritesChanged(zoneId, items.length);
  return updated;
}

/**
 * -----------------------------------------------------------------------------
 * favoritesManager
 * -----------------------------------------------------------------------------
 * Manages the lifecycle of favorites for each audio zone.
 * Provides CRUD operations (create, read, update, delete),
 * ordering, copying, and playback lookup.
 * -----------------------------------------------------------------------------
 */
export const favoritesManager = {
  /**
   * Returns a list of favorites for a specific zone.
   * Optionally supports pagination (start, limit).
   * Builds fake but Loxone-compatible `audiopath` values
   * like `spotify:track:xxx` or `tunein:station:s6707`.
   */
  async get(zoneId: number, start = 0, limit = 0): Promise<FavoriteResponse> {
    const stored = await loadFavorites(zoneId);
    const list = limit > 0 ? stored.items.slice(start, start + limit) : stored.items;

    const items = list.map((i) => {
      const id = i.audiopath.split('/').pop() ?? i.audiopath;
      const prefix = prefixMap[i.type] ?? prefixMap.spotify_track;
      const audiopath = `${prefix}${id}`;

      return {
        ...i,
        plus: true,
        audiopath,
        type: i.type || detectType(audiopath),
        coverurl: i.coverurl || '',
      };
    });

    return { id: zoneId, type: FileType.Favorite, start, totalitems: items.length, items };
  },

  /**
   * Adds a new favorite to the given zone.
   * Automatically detects the media type, fetches metadata via the provider,
   * and updates both persistent storage and clients.
   */
  async add(zoneId: number, title: string, sourceId: string): Promise<FavoriteResponse> {
    const favs = await loadFavorites(zoneId);
    const nextId = favs.items.length ? Math.max(...favs.items.map(f => f.id)) + 1 : 1;

    const meta = await providerRuntime.resolveItem(sourceId);
    const item: FavoriteItem = {
      id: nextId,
      slot: favs.items.length + 1,
      plus: true,
      name: title,
      title,
      album: meta?.album?.name ?? '',
      artist: meta?.artist ?? meta?.artists?.[0]?.name ?? '',
      audiopath: sourceId,
      type: detectType(sourceId),
      coverurl: extractImageFromTrack(meta),
    };

    const updated = await persist(zoneId, [...favs.items, item]);
    logger.info(`[favorites][zone:${zoneId}] Added "${title}" (${sourceId})`);
    return updated;
  },

  /**
   * Removes a favorite from a zone by its internal ID.
   * Recalculates slot positions and notifies clients.
   */
  async remove(zoneId: number, id: number): Promise<FavoriteResponse> {
    const favs = await loadFavorites(zoneId);
    const items = favs.items.filter(f => f.id !== id).map((f, i) => ({ ...f, slot: i + 1 }));
    const updated = await persist(zoneId, items);
    logger.info(`[favorites][zone:${zoneId}] Deleted favorite ${id}`);
    return updated;
  },

  /**
   * Updates the internal numeric ID of a favorite.
   * Typically used when syncing or migrating stored data.
   */
  async setId(zoneId: number, oldId: number, newId: number): Promise<FavoriteResponse> {
    const favs = await loadFavorites(zoneId);
    const items = favs.items.map(f => (f.id === oldId ? { ...f, id: newId } : f));
    const updated = await persist(zoneId, items);
    logger.info(`[favorites][zone:${zoneId}] Updated favorite id ${oldId} → ${newId}`);
    return updated;
  },

  /**
   * Reorders favorites according to a new sequence of IDs.
   * Missing IDs are appended at the end in their existing order.
   */
  async reorder(zoneId: number, newOrder: readonly number[]): Promise<FavoriteResponse> {
    const favs = await loadFavorites(zoneId);
    const byId = new Map(favs.items.map(f => [f.id, f]));
    const ordered = [...newOrder.map(id => byId.get(id)).filter(Boolean) as FavoriteItem[]];

    for (const f of favs.items) {
      if (!ordered.some(o => o.id === f.id)) {
        ordered.push(f);
      }
    }
    const items = ordered.map((f, i) => ({ ...f, slot: i + 1, plus: true }));
    const updated = await persist(zoneId, items);
    logger.info(`[favorites][zone:${zoneId}] Reordered favorites`);
    return updated;
  },

  /**
   * Copies the favorites list from one zone to one or more destination zones.
   * Each destination zone receives an identical list with an updated timestamp.
   */
  async copy(sourceZone: number, destZones: readonly number[]): Promise<void> {
    const source = await loadFavorites(sourceZone);
    for (const dest of destZones) {
      if (dest === sourceZone) {
        continue;
      }
      const copy: FavoriteResponse = { ...source, id: dest, ts: Date.now() };
      await saveFavorites(dest, copy);
      notifyRoomFavoritesChanged(dest, source.items.length);
      logger.info(`[favorites][zone:${sourceZone}] Copied favorites → zone:${dest}`);
    }
  },

  /**
   * Returns a favorite item by ID for playback.
   * Used by the runtime when executing a "play favorite" command.
   */
  async getForPlayback(zoneId: number, favoriteId: number): Promise<FavoriteItem | undefined> {
    const favs = await loadFavorites(zoneId);
    const item = favs.items.find(f => f.id === favoriteId);
    if (!item) {
      logger.warn(`[favorites][zone:${zoneId}] Favorite ${favoriteId} not found for playback`);
      return;
    }
    return item;
  },
};