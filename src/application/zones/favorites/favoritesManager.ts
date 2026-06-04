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
    const normalized = items.map((item) => {
      const normalizedPath = normalizeFavoriteAudiopath(item.audiopath);
      const detectedService = detectService(normalizedPath);
      const hasMeaningfulService =
        typeof item.service === 'string' && item.service.trim().length > 0 && item.service !== 'custom';
      const hasMeaningfulServiceType =
        typeof item.serviceType === 'number' && item.serviceType !== 3;
      const resolvedType = resolveFavoriteType(item.type, normalizedPath);
      const ownerString = typeof item.owner === 'string' ? item.owner : '';
      // Loxone v2 schemas demand `ownerId` (and the alt-spelled `owner_id`) for
      // spotify_playlist / spotify_collection favorites. Without them the client
      // drops the item silently via `.catch(() => null).filter(Boolean)`.
      const needsOwnerId =
        resolvedType === 'spotify_playlist' || resolvedType === 'spotify_collection';
      const ownerFields = needsOwnerId
        ? { ownerId: ownerString, owner_id: ownerString }
        : {};
      return {
        ...item,
        plus: true,
        audiopath: normalizedPath,
        type: resolvedType,
        service: hasMeaningfulService ? item.service : detectedService.name,
        serviceType: hasMeaningfulServiceType ? item.serviceType : detectedService.type,
        ...ownerFields,
      };
    });
    return {
      ...stored,
      start,
      totalitems: stored.items.length,
      items: normalized,
    };
  }

  public async add(zoneId: number, title: string, audiopath: string): Promise<FavoriteItem> {
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
    await this.persist(zoneId, [...stored.items, item]);
    return item;
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

  public async setName(zoneId: number, id: number, name: string): Promise<FavoriteResponse> {
    const stored = await loadFavorites(zoneId);
    const items = stored.items.map((item) =>
      item.id === id ? { ...item, name, title: name } : item,
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
  if (lower.startsWith('library:') || lower.startsWith('local:')) {
    if (lower.includes(':playlist:')) {
      return 'playlist';
    }
    // The native client only knows library_track / library_folder / library_playlist
    // for local items — it has no library_artist/library_album type and silently
    // drops favorites with an unknown type. Artists and albums are browsable
    // containers, so map them (and explicit folders) to library_folder.
    if (lower.includes(':folder:') || lower.includes(':album:') || lower.includes(':artist:')) {
      return 'library_folder';
    }
    return 'library_track';
  }
  if (lower.startsWith('spotify:')) {
    // Apple Music (bridge) library items carry a `library-` kind prefix
    // (e.g. `spotify:library-artist:…`); match both the plain and library forms.
    if (lower.includes(':user:collection')) {
      return 'spotify_collection';
    }
    if (/:(library-)?playlist:/.test(lower)) {
      return 'spotify_playlist';
    }
    if (/:(library-)?album:/.test(lower)) {
      return 'spotify_album';
    }
    if (/:(library-)?artist:/.test(lower)) {
      return 'spotify_artist';
    }
    if (/:(library-)?show:/.test(lower)) {
      return 'spotify_show';
    }
    if (/:(library-)?episode:/.test(lower)) {
      return 'spotify_episode';
    }
    return 'spotify_track';
  }
  if (lower.startsWith('linein:')) {
    return 'linein';
  }
  if (/^https?:\/\//.test(lower)) {
    return 'custom_stream';
  }
  if (lower.startsWith('tunein:') || /(tunein|radio)/.test(lower)) {
    return 'tunein';
  }
  if (lower.startsWith('soundsuit:') || lower.includes(':schedule:') || lower.includes(':station:')) {
    return 'soundsuit';
  }
  if (lower.includes(':playlist')) {
    return 'playlist';
  }
  return 'custom_stream';
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
  if (lower.startsWith('library:') || lower.startsWith('local:')) {
    return { name: 'library', type: 2 };
  }
  if (lower.startsWith('spotify:')) {
    return { name: 'spotify', type: 3 };
  }
  if (lower.startsWith('tunein:')) {
    return { name: 'tunein', type: 3 };
  }
  if (lower.startsWith('soundsuit:')) {
    return { name: 'soundsuit', type: 3 };
  }
  if (lower.startsWith('linein:')) {
    return { name: 'linein', type: 99 };
  }
  return { name: 'custom', type: 3 };
}

const KNOWN_FAVORITE_TYPES = new Set([
  'library_track',
  'library_folder',
  'playlist',
  'linein',
  'tunein',
  'custom_stream',
  'loxoneradio',
  'soundsuit',
  'normal',
  'spotify_track',
  'spotify_playlist',
  'spotify_collection',
  'spotify_album',
  'spotify_artist',
  'spotify_show',
  'spotify_episode',
]);

// Item kinds the audiopath asserts authoritatively (everything except the
// kind-less `*_track` fallbacks). Used to heal stored mislabels on read without
// ever downgrading a good type to the track fallback.
const AUTHORITATIVE_ITEM_TYPES = new Set([
  'spotify_playlist',
  'spotify_collection',
  'spotify_album',
  'spotify_artist',
  'spotify_show',
  'spotify_episode',
]);

function resolveFavoriteType(storedType: unknown, audiopath: string): string {
  const detected = detectTypeFromAudiopath(audiopath);
  // The audiopath is authoritative for an item's kind: heal stale mislabels
  // (e.g. an Apple `library-artist` saved as spotify_track, or a local
  // `library:artist:` saved as library_track) instead of trusting the stored type.
  if (AUTHORITATIVE_ITEM_TYPES.has(detected)) {
    return detected;
  }
  if (typeof storedType === 'string' && KNOWN_FAVORITE_TYPES.has(storedType)) {
    return storedType;
  }
  return detected;
}
