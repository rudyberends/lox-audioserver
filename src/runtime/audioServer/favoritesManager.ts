import logger from '@/utils/troxorLogger';
import { broadcastMessage } from '@/http/loxoneHttp/websocketManager';
import { loadFavorites, saveFavorites } from '@/model/local/favorites/favoritesStore';
import type { FavoriteItem, FavoriteResponse } from '@/model/local/favorites/types';
import { providerRuntime } from '@/runtime/provider';
import { extractImageFromTrack } from '@/model/adapters/musicAssistant/utils/imageUtils';
import { FileType } from '@/core/types/loxone';

function broadcast(zoneId: number, count: number): void {
  broadcastMessage(
    JSON.stringify({
      roomfavchanged_event: [{ playerid: zoneId, count }],
    }),
  );
}

export const favoritesManager = {
  /** Get favorites for zone */
  async get(zoneId: number, start = 0, limit = 0): Promise<FavoriteResponse> {
    const stored = await loadFavorites(zoneId);
    const items = limit > 0 ? stored.items.slice(start, start + limit) : stored.items;

    const prefixMap: Record<string, string> = {
      tunein: 'tunein:station:s',
      spotify_playlist: 'spotify:playlist:',
      playlist: 'playlist:',
      spotify_artist: 'spotify:artist:',
      spotify_album: 'spotify:album:',
      spotify_track: 'spotify:track:',
    };

    const cleanItems = items.map((i) => {
      const id = i.audiopath.split('/').pop() ?? i.audiopath;
      const prefix = prefixMap[i.type] ?? 'spotify:track:';
      const audiopath = `${prefix}${id}`;

      return {
        id: i.id,
        slot: i.slot,
        plus: true,
        name: i.name,
        title: i.title,
        album: i.album,
        artist: i.artist,
        audiopath,
        type: i.type || detectType(audiopath),
        coverurl: i.coverurl || '',
      };
    });

    return {
      id: zoneId,
      type: FileType.Favorite,
      start,
      totalitems: cleanItems.length,
      items: cleanItems,
    };
  },

  /** Add a new favorite to a zone */
  async add(zoneId: number, title: string, sourceId: string): Promise<FavoriteResponse> {
    const favs = await loadFavorites(zoneId);
    const nextId = favs.items.length ? Math.max(...favs.items.map((f) => f.id)) + 1 : 1;
    const slot = favs.items.length + 1;
    const audiopath = sourceId;

    // Detect media type
    const type = detectType(audiopath);
    const meta = await providerRuntime.resolveItem(audiopath);
    const coverurl = extractImageFromTrack(meta);
    const album = meta?.album?.name ?? '';
    const artist = meta?.artist ?? meta?.artists?.[0]?.name ?? '';

    const item: FavoriteItem = {
      id: nextId,
      slot,
      plus: true,
      name: title,
      title,
      album,
      artist,
      audiopath,
      type,
      coverurl,
    };

    const updated: FavoriteResponse = {
      id: zoneId,
      type: FileType.Favorite,
      start: 0,
      totalitems: favs.items.length + 1,
      items: [...favs.items, item],
    };

    await saveFavorites(zoneId, updated);
    broadcast(zoneId, updated.items.length);
    logger.info(`[favorites][zone:${zoneId}] Added "${title}" (${audiopath})`);
    return updated;
  },

  /** Remove a favorite */
  async remove(zoneId: number, id: number): Promise<FavoriteResponse> {
    const favs = await loadFavorites(zoneId);
    const remaining = favs.items
      .filter((f) => f.id !== id)
      .map((f, i) => ({ ...f, slot: i + 1 }));

    const updated: FavoriteResponse = {
      id: zoneId,
      type: FileType.Favorite,
      start: 0,
      totalitems: remaining.length,
      items: remaining,
    };

    await saveFavorites(zoneId, updated);
    broadcast(zoneId, remaining.length);
    logger.info(`[favorites][zone:${zoneId}] Deleted favorite ${id}`);
    return updated;
  },

  /** Update ID for a favorite */
  async setId(zoneId: number, oldId: number, newId: number): Promise<FavoriteResponse> {
    const favs = await loadFavorites(zoneId);
    const updatedItems = favs.items.map((f) =>
      f.id === oldId ? { ...f, id: newId } : f,
    );

    const updated: FavoriteResponse = {
      id: zoneId,
      type: FileType.Favorite,
      start: 0,
      totalitems: updatedItems.length,
      items: updatedItems,
    };

    await saveFavorites(zoneId, updated);
    broadcast(zoneId, updatedItems.length);
    logger.info(`[favorites][zone:${zoneId}] Updated favorite id ${oldId} → ${newId}`);
    return updated;
  },

  /** Reorder favorites */
  async reorder(zoneId: number, newOrder: readonly number[]): Promise<FavoriteResponse> {
    const favs = await loadFavorites(zoneId);
    const byId = new Map(favs.items.map((f) => [f.id, f]));
    const reordered = newOrder.map((id) => byId.get(id)).filter((f): f is FavoriteItem => !!f);

    for (const f of favs.items) {
      if (!reordered.some((r) => r.id === f.id)) {
        reordered.push(f);
      }
    }

    const withSlots = reordered.map((f, i) => ({ ...f, slot: i + 1, plus: true }));
    const updated: FavoriteResponse = {
      id: zoneId,
      type: FileType.Favorite,
      start: 0,
      totalitems: withSlots.length,
      items: withSlots,
    };

    await saveFavorites(zoneId, updated);
    broadcast(zoneId, withSlots.length);
    logger.info(`[favorites][zone:${zoneId}] Reordered favorites`);
    return updated;
  },

  /** Copy favorites */
  async copy(sourceZone: number, destZones: readonly number[]): Promise<void> {
    const source = await loadFavorites(sourceZone);
    for (const dest of destZones) {
      if (dest === sourceZone) {
        continue;
      }
      const copy: FavoriteResponse = { ...source, id: dest, ts: Date.now() };
      await saveFavorites(dest, copy);
      broadcast(dest, source.items.length);
      logger.info(`[favorites][zone:${sourceZone}] Copied favorites → zone:${dest}`);
    }
  },

  /** Resolve a favorite for playback */
  async getForPlayback(zoneId: number, favoriteId: number): Promise<FavoriteItem | undefined> {
    const favs = await loadFavorites(zoneId);
    const item = favs.items.find((f) => f.id === favoriteId);
    if (!item) {
      logger.warn(`[favorites][zone:${zoneId}] Favorite ${favoriteId} not found for playback`);
      return undefined;
    }
    return item;
  },
};

/** Determine media type from audiopath */
function detectType(audiopath: string): string {
  if (/^tunein:/.test(audiopath)) return 'tunein';
  if (/radio/i.test(audiopath)) return 'tunein';
  if (/playlist/i.test(audiopath)) return 'spotify_playlist';
  if (/album/i.test(audiopath)) return 'spotify_album';
  if (/artist/i.test(audiopath)) return 'spotify_artist';
  if (/track/i.test(audiopath)) return 'spotify_track';
  return 'unknown';
}