import { ensureDir, resolveDataDir, readOrDefaultJson, writeJson } from '@/core/utils/file';
import type { FavoriteResponse } from './types';
import logger from '@/utils/troxorLogger';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const FAVORITES_DIR = resolveDataDir('favorites');

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/** Build absolute path to a zone’s favorites file. */
function getFilePath(zoneId: number): string {
  return resolveDataDir('favorites', `${zoneId}.json`);
}

/** Create a new default Loxone-compatible structure. */
function createDefaultFavorites(zoneId: number): FavoriteResponse {
  return {
    id: zoneId,
    type: 4,
    start: 0,
    totalitems: 0,
    items: [],
  };
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/** Load favorites for a zone. If missing, a default structure is returned. */
export async function loadFavorites(zoneId: number): Promise<FavoriteResponse> {
  await ensureDir(FAVORITES_DIR);
  const file = getFilePath(zoneId);
  return readOrDefaultJson(file, createDefaultFavorites(zoneId), true);
}

/** Persist favorites exactly as returned by the runtime. */
export async function saveFavorites(zoneId: number, data: FavoriteResponse): Promise<void> {
  await ensureDir(FAVORITES_DIR);
  const file = getFilePath(zoneId);

  // Always store in Loxone-native format
  const payload: FavoriteResponse = {
    id: data.id ?? zoneId,
    type: 4,
    start: data.start ?? 0,
    totalitems: data.items.length,
    items: data.items,
  };

  await writeJson(file, payload);
  logger.debug(`[FavoritesStore][zone:${zoneId}] Saved ${payload.items.length} favorites`);
}