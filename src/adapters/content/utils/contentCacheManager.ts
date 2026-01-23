import type { ContentFolder } from '@/ports/ContentTypes';

type CacheEntry = {
  data: ContentFolder | null;
  expiresAt: number;
  refreshPromise?: Promise<ContentFolder | null>;
};

/**
 * Lightweight stale-while-revalidate cache for content folders.
 * Keeps responses in memory for a short TTL and deduplicates concurrent refreshes.
 */
export class ContentCacheManager {
  private readonly store = new Map<string, CacheEntry>();
  // modest ttl; folders change infrequently but keep short to avoid stale data
  private readonly ttlMs = 5 * 60 * 1000;

  public key(service: string, user: string, folderId: string, offset: number, limit: number): string {
    return `${service}|${user}|${folderId}|${offset}|${limit}`;
  }

  public get(key: string): ContentFolder | null | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      return entry.data; // stale allowed; background refresh will run
    }
    return entry.data;
  }

  public async refresh(
    key: string,
    fetcher: () => Promise<ContentFolder | null>,
  ): Promise<ContentFolder | null> {
    const existing = this.store.get(key);
    if (existing?.refreshPromise) {
      return existing.refreshPromise;
    }
    const refreshPromise = (async () => {
      try {
        const data = await fetcher();
        this.store.set(key, { data, expiresAt: Date.now() + this.ttlMs });
        return data;
      } finally {
        const entry = this.store.get(key);
        if (entry) {
          delete entry.refreshPromise;
        }
      }
    })();
    this.store.set(key, {
      data: existing?.data ?? null,
      expiresAt: existing?.expiresAt ?? 0,
      refreshPromise,
    });
    return refreshPromise;
  }

  public clearAll(): void {
    this.store.clear();
  }
}
