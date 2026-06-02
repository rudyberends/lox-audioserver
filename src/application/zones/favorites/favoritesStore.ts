import { readdir, unlink } from 'node:fs/promises';
import { ensureDir, readOrDefaultJson, resolveDataDir, writeJson } from '@/shared/utils/file';
import { bestEffort } from '@/shared/bestEffort';
import type { FavoriteResponse } from '@/application/zones/favorites/types';

const FAVORITES_DIR = resolveDataDir('favorites');

// Ephemeral browser zones (id >= 9000) are per-tab and their id↔browser mapping
// is not persisted, so per-id files would leak between browsers across restarts.
// Route them all to one shared "browser" store instead.
const BROWSER_ZONE_BASE = 9000;
function storeKey(zoneId: number): string {
  return zoneId >= BROWSER_ZONE_BASE ? 'browser' : String(zoneId);
}

function filePath(zoneId: number): string {
  return resolveDataDir('favorites', `${storeKey(zoneId)}.json`);
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
  const fav = await readOrDefaultJson(filePath(zoneId), defaultFavorites(zoneId), true);
  // The shared browser store may have been written under another browser zone's
  // id; always report the requesting zone's id back to the client.
  return { ...fav, id: zoneId };
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
