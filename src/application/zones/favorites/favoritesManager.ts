import { clearAllFavorites, loadFavorites, saveFavorites } from '@/application/zones/favorites/favoritesStore';
import type { FavoriteItem, FavoriteResponse } from '@/application/zones/favorites/types';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ContentPort } from '@/ports/ContentPort';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import { bestEffort } from '@/shared/bestEffort';

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

export class FavoritesManager {
  private notifier: NotifierPort;
  private zoneManager: ZoneManagerFacade | null = null;
  private contentPort: ContentPort;

  constructor(notifier: NotifierPort, contentPort: ContentPort) {
    this.notifier = notifier;
    this.contentPort = contentPort;
  }

  public setNotifier(notifier: NotifierPort): void {
    this.notifier = notifier;
  }

  public initOnce(deps: { zoneManager: ZoneManagerFacade }): void {
    if (this.zoneManager) {
      throw new Error('favorites manager already initialized');
    }
    if (!deps.zoneManager) {
      throw new Error('favorites manager missing zone manager');
    }
    this.zoneManager = deps.zoneManager;
  }

  private get zones(): ZoneManagerFacade {
    if (!this.zoneManager) {
      throw new Error('zone manager not configured');
    }
    return this.zoneManager;
  }

  private async persist(zoneId: number, items: FavoriteItem[]): Promise<FavoriteResponse> {
    const response: FavoriteResponse = {
      id: zoneId,
      type: 4,
      start: 0,
      totalitems: items.length,
      items,
      ts: Date.now(),
    };
    await saveFavorites(zoneId, response);
    this.notifier.notifyRoomFavoritesChanged(zoneId, items.length);
    return response;
  }

  public async get(zoneId: number, start = 0, limit = 50): Promise<FavoriteResponse> {
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
  }

  public async add(zoneId: number, title: string, audiopath: string): Promise<FavoriteResponse> {
    const stored = await loadFavorites(zoneId);
    const nextId = stored.items.length
      ? Math.max(...stored.items.map((item) => item.id)) + 1
      : 1;
    const state = this.zones.getState(zoneId);
    const providerId =
      extractProviderId(audiopath) ||
      (state?.audiopath ? extractProviderId(state.audiopath) : null);
    const normalizedAudiopath = normalizeFavoriteAudiopath(audiopath);
    // Best-effort metadata lookup; missing metadata should not block favorites.
    const meta = await bestEffort(() => this.contentPort.resolveMetadata(audiopath), {
      fallback: null,
    });
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
    return this.persist(zoneId, [...stored.items, item]);
  }

  public async remove(zoneId: number, id: number): Promise<FavoriteResponse> {
    const stored = await loadFavorites(zoneId);
    const items = stored.items
      .filter((item) => item.id !== id)
      .map((item, index) => ({ ...item, slot: index + 1 }));
    return this.persist(zoneId, items);
  }

  public async setId(zoneId: number, oldId: number, newId: number): Promise<FavoriteResponse> {
    const stored = await loadFavorites(zoneId);
    const items = stored.items.map((item) =>
      item.id === oldId ? { ...item, id: newId } : item,
    );
    return this.persist(zoneId, items);
  }

  public async reorder(zoneId: number, newOrder: readonly number[]): Promise<FavoriteResponse> {
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

    return this.persist(zoneId, items);
  }

  public async copy(zoneId: number, destinations: readonly number[]): Promise<void> {
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
      this.notifier.notifyRoomFavoritesChanged(dest, source.items.length);
    }
  }

  public async getForPlayback(zoneId: number, favoriteId: number): Promise<FavoriteItem | undefined> {
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
  }

  public async getAudiopathForFavorite(zoneId: number, favoriteId: number): Promise<string | null> {
    const favorite = await this.getForPlayback(zoneId, favoriteId);
    return favorite?.audiopath ?? null;
  }

  public async clearAll(): Promise<void> {
    await clearAllFavorites();
  }

  public async clear(zoneId: number): Promise<void> {
    await this.persist(zoneId, []);
  }
}

type FavoritesManagerDeps = {
  notifier: NotifierPort;
  contentPort: ContentPort;
};

export function createFavoritesManager(deps: FavoritesManagerDeps): FavoritesManager {
  return new FavoritesManager(deps.notifier, deps.contentPort);
}

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
