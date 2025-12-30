import { clearAllFavorites, loadFavorites, saveFavorites } from '@/modules/zones/favorites/favoritesStore';
import { contentManager } from '@/modules/content/contentManager';
import type { FavoriteItem, FavoriteResponse } from '@/modules/zones/favorites/types';
import { notifyRoomFavoritesChanged } from '@/modules/loxone/ws/notifier';
import { zoneManager } from '@/modules/zones/zoneManager';

function createItem(id: number, slot: number, title: string, audiopath: string): FavoriteItem {
  const providerId = extractProviderId(audiopath);
  const normalizedPath = normalizeFavoriteAudiopath(audiopath);
  const type = detectTypeFromAudiopath(normalizedPath);
  const service = detectService(normalizedPath);
  return {
    id,
    slot,
    plus: true,
    name: title,
    title,
    audiopath: normalizedPath,
    type,
    coverurl: '',
    artist: '',
    album: '',
    service: service.name,
    serviceType: service.type,
    owner: providerId ?? '',
  };
}

async function persist(zoneId: number, items: FavoriteItem[]): Promise<FavoriteResponse> {
  const response: FavoriteResponse = {
    id: zoneId,
    type: 4,
    start: 0,
    totalitems: items.length,
    items,
    ts: Date.now(),
  };
  await saveFavorites(zoneId, response);
  notifyRoomFavoritesChanged(zoneId, items.length);
  return response;
}

export const favoritesManager = {
  async get(zoneId: number, start = 0, limit = 50): Promise<FavoriteResponse> {
    const stored = await loadFavorites(zoneId);
    const items = limit > 0 ? stored.items.slice(start, start + limit) : stored.items;
    const normalized = items.map((item) => ({
      ...item,
      plus: true,
      audiopath: normalizeFavoriteAudiopath(item.audiopath),
      type:
        typeof item.type === 'string'
          ? item.type
          : detectTypeFromAudiopath(normalizeFavoriteAudiopath(item.audiopath)),
      service: item.service ?? detectService(normalizeFavoriteAudiopath(item.audiopath)).name,
      serviceType:
        item.serviceType ?? detectService(normalizeFavoriteAudiopath(item.audiopath)).type,
    }));
    return {
      ...stored,
      start,
      totalitems: stored.items.length,
      items: normalized,
    };
  },

  async add(zoneId: number, title: string, audiopath: string): Promise<FavoriteResponse> {
    const stored = await loadFavorites(zoneId);
    const nextId = stored.items.length
      ? Math.max(...stored.items.map((item) => item.id)) + 1
      : 1;
    const state = zoneManager.getState(zoneId);
    const providerId =
      extractProviderId(audiopath) ||
      (state?.audiopath ? extractProviderId(state.audiopath) : null);
    const normalizedAudiopath = normalizeFavoriteAudiopath(audiopath);
    const meta = await contentManager.resolveMetadata(audiopath).catch(() => null);
    const stateMeta = state?.audiopath
      ? {
          title: state.title ?? '',
          name: state.title ?? '',
          artist: state.artist ?? '',
          album: state.album ?? '',
          coverurl: state.coverurl ?? '',
        }
      : null;
    const item = {
      ...createItem(nextId, stored.items.length + 1, title, normalizedAudiopath),
      title: meta?.title ?? stateMeta?.title ?? title,
      name: meta?.title ?? stateMeta?.name ?? title,
      artist: meta?.artist ?? stateMeta?.artist ?? '',
      album: meta?.album ?? stateMeta?.album ?? '',
      coverurl: meta?.coverurl ?? stateMeta?.coverurl ?? '',
      owner: providerId ?? '',
    };
    return persist(zoneId, [...stored.items, item]);
  },

  async remove(zoneId: number, id: number): Promise<FavoriteResponse> {
    const stored = await loadFavorites(zoneId);
    const items = stored.items
      .filter((item) => item.id !== id)
      .map((item, index) => ({ ...item, slot: index + 1 }));
    return persist(zoneId, items);
  },

  async setId(zoneId: number, oldId: number, newId: number): Promise<FavoriteResponse> {
    const stored = await loadFavorites(zoneId);
    const items = stored.items.map((item) =>
      item.id === oldId ? { ...item, id: newId } : item,
    );
    return persist(zoneId, items);
  },

  async reorder(zoneId: number, newOrder: readonly number[]): Promise<FavoriteResponse> {
    const stored = await loadFavorites(zoneId);
    const byId = new Map(stored.items.map((item) => [item.id, item]));
    const ordered: FavoriteItem[] = [];

    newOrder.forEach((id) => {
      const entry = byId.get(id);
      if (entry) {
        ordered.push(entry);
      }
    });

    stored.items.forEach((item) => {
      if (!ordered.some((existing) => existing.id === item.id)) {
        ordered.push(item);
      }
    });

    const items = ordered.map((item, index) => ({
      ...item,
      slot: index + 1,
      plus: true,
    }));

    return persist(zoneId, items);
  },

  async copy(zoneId: number, destinations: readonly number[]): Promise<void> {
    const source = await loadFavorites(zoneId);
    for (const dest of destinations) {
      if (dest === zoneId) {
        continue;
      }
      await saveFavorites(dest, {
        ...source,
        id: dest,
        ts: Date.now(),
      });
      notifyRoomFavoritesChanged(dest, source.items.length);
    }
  },

  async getForPlayback(zoneId: number, favoriteId: number): Promise<FavoriteItem | undefined> {
    const stored = await loadFavorites(zoneId);
    const item = stored.items.find((i) => i.id === favoriteId);
    if (item) {
      const providerId =
        typeof item.owner === 'string' && item.owner.trim() ? item.owner.trim() : undefined;
      const audiopathWithProvider = attachProviderToAudiopath(
        normalizeFavoriteAudiopath(item.audiopath),
        providerId,
      );
      return {
        ...item,
        audiopath: audiopathWithProvider,
        type:
          typeof item.type === 'string'
            ? item.type
            : detectTypeFromAudiopath(audiopathWithProvider),
      };
    }
    return undefined;
  },

  async getAudiopathForFavorite(zoneId: number, favoriteId: number): Promise<string | null> {
    const favorite = await this.getForPlayback(zoneId, favoriteId);
    return favorite?.audiopath ?? null;
  },

  async clearAll(): Promise<void> {
    await clearAllFavorites();
  },

  async clear(zoneId: number): Promise<void> {
    await persist(zoneId, []);
  },
};

function detectTypeFromAudiopath(audiopath: string): string {
  const lower = (audiopath || '').toLowerCase();
  const service = detectService(audiopath).name;
  if (/(tunein|radio)/.test(lower)) {
    return 'tunein';
  }
  if (lower.includes(':playlist')) {
    return 'playlist';
  }
  if (lower.includes(':album:')) {
    return `${service}_album`;
  }
  if (lower.includes(':artist:')) {
    return `${service}_artist`;
  }
  if (lower.includes(':track:')) {
    return `${service}_track`;
  }
  return 'unknown';
}

function normalizeFavoriteAudiopath(audiopath: string): string {
  if (!audiopath) return audiopath;
  if (audiopath.startsWith('spotify@')) {
    const tail = audiopath.replace(/^spotify@[^:]+:/i, 'spotify:');
    return tail.replace(/:library-track:/i, ':track:');
  }
  return audiopath.replace(/:library-track:/i, ':track:');
}

function extractProviderId(audiopath: string): string | null {
  if (!audiopath) return null;
  const match = /^spotify@([^:]+):/i.exec(audiopath);
  return match?.[1] ?? null;
}

function attachProviderToAudiopath(audiopath: string, providerId?: string): string {
  if (!audiopath || !providerId) {
    return audiopath;
  }
  return `spotify@${providerId}:${audiopath.replace(/^spotify:/i, '')}`;
}

function detectService(
  audiopath: string,
): { name: string; type: number } {
  const lower = (audiopath || '').toLowerCase();
  if (lower.startsWith('spotify:')) {
    return { name: 'spotify', type: 3 };
  }
  if (lower.startsWith('tunein:')) {
    return { name: 'tunein', type: 3 };
  }
  if (lower.startsWith('linein:')) {
    return { name: 'linein', type: 99 };
  }
  return { name: 'custom', type: 3 };
}
