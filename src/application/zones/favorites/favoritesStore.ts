import { readdir, unlink } from 'node:fs/promises';
import { ensureDir, readOrDefaultJson, resolveDataDir, writeJson } from '@/shared/utils/file';
import { bestEffort } from '@/shared/bestEffort';
import type { FavoriteResponse } from '@/application/zones/favorites/types';

const FAVORITES_DIR = resolveDataDir('favorites');

function filePath(zoneId: number): string {
  return resolveDataDir('favorites', `${zoneId}.json`);
}

function defaultFavorites(zoneId: number): FavoriteResponse {
  return {
    id: zoneId,
    type: 4,
    start: 0,
    totalitems: 0,
    items: [],
  };
}

export async function loadFavorites(zoneId: number): Promise<FavoriteResponse> {
  await ensureDir(FAVORITES_DIR);
  return readOrDefaultJson(filePath(zoneId), defaultFavorites(zoneId), true);
}

export async function saveFavorites(zoneId: number, payload: FavoriteResponse): Promise<void> {
  await ensureDir(FAVORITES_DIR);
  const normalized: FavoriteResponse = {
    id: zoneId,
    type: 4,
    start: payload.start ?? 0,
    totalitems: payload.items.length,
    items: payload.items,
    ts: payload.ts,
  };
  await writeJson(filePath(zoneId), normalized);
}

export async function clearAllFavorites(): Promise<void> {
  await ensureDir(FAVORITES_DIR);
  // Best-effort cleanup; treat unreadable directory as empty.
  const entries = await bestEffort(() => readdir(FAVORITES_DIR), { fallback: [] });
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.endsWith('.json')) return;
      const target = resolveDataDir('favorites', entry);
      // Best-effort cleanup; missing files are ignored.
      await bestEffort(() => unlink(target), { fallback: undefined });
    }),
  );
}
