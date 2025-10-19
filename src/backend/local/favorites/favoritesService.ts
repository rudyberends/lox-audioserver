import path from "path";
import logger from "../../../utils/troxorlogger";
import { broadcastEvent } from "../../../http/broadcastEvent";
import { FavoriteItem, FavoriteResponse } from "../../provider/types";
import { ensureDir, readJson, writeJson, resolveDataDir } from "../../../utils/fileutils";

const FAVORITES_DIR = resolveDataDir("favorites");

/**
 * Builds the absolute file path for a given zone's favorites file.
 * @param zoneId - The numeric ID of the zone (e.g., a room or device group).
 * @returns The absolute JSON file path for that zone's favorites list.
 */
function getFavoritesFilePath(zoneId: number): string {
  return path.join(FAVORITES_DIR, `${zoneId}.json`);
}
/**
 * Loads and parses a zone’s favorites file. If it doesn't exist,
 * an empty structure is returned.
 * @param zoneId - The zone to load favorites for.
 * @returns The current favorites state for the given zone.
 */
async function load(zoneId: number): Promise<FavoriteResponse> {
  await ensureDir(FAVORITES_DIR);
  const data = await readJson<FavoriteResponse>(getFavoritesFilePath(zoneId));
  return (
    data ?? {
      id: String(zoneId),
      name: "Favorites",
      totalitems: 0,
      start: 0,
      items: [],
      ts: Date.now(),
    }
  );
}

/**
 * Writes a favorites structure to disk and triggers a broadcast event.
 * @param zoneId - The target zone whose favorites have been updated.
 * @param data - The favorites payload to persist.
 */
async function save(zoneId: number, data: FavoriteResponse): Promise<void> {
  data.totalitems = data.items.length;
  await writeJson(getFavoritesFilePath(zoneId), data);

  logger.debug(`[favorites][zone:${zoneId}] Saved ${data.items.length} items`);
  broadcastEvent(
    JSON.stringify({
      roomfavchanged_event: [
        { count: data.items.length, playerid: zoneId },
      ],
    }),
  );
}

/**
 * Retrieves favorites for a specific zone, with optional pagination.
 * @param zoneId - The zone to read favorites from.
 * @param start - Optional start index (defaults to 0).
 * @param limit - Optional limit of items to return (0 = all).
 * @returns A {@link FavoriteResponse} containing the requested items.
 */
export async function getRoomFavorites(
  zoneId: number,
  start = 0,
  limit = 0,
): Promise<FavoriteResponse> {
  const favs = await load(zoneId);
  const items =
    limit > 0 ? favs.items.slice(start, start + limit) : favs.items;
  return { ...favs, start, totalitems: favs.items.length, items };
}

/**
 * Appends a new favorite to the given zone.
 * IDs increment automatically; `slot` defines ordering.
 * @param zoneId - Zone to add the favorite to.
 * @param title - Human-readable title or track name.
 * @param sourceId - Backend identifier for the audio source.
 * @returns The updated {@link FavoriteResponse} after insertion.
 */
export async function addRoomFavorite(
  zoneId: number,
  title: string,
  sourceId: string,
): Promise<FavoriteResponse> {
  const favs = await load(zoneId);
  const id =
    favs.items.length > 0 ? Math.max(...favs.items.map((f) => f.id)) + 1 : 1;
  const slot = favs.items.length + 1;

  const item: FavoriteItem = {
    id,
    slot,
    plus: false,
    name: title,
    title,
    album: "",
    artist: "",
    audiopath: sourceId,
    type: "library_track",
    coverurl: "",
    rawId: sourceId,
  };

  favs.items.push(item);
  favs.ts = Date.now();
  logger.info(`[favorites][zone:${zoneId}] Added "${title}"`);
  await save(zoneId, favs);
  return favs;
}

/**
 * Deletes a favorite by its numeric ID.
 * Automatically reorders slots to remain sequential.
 * @param zoneId - Zone to modify.
 * @param id - Numeric or string ID of the favorite to remove.
 * @returns The updated {@link FavoriteResponse} after deletion.
 */
export async function deleteRoomFavorite(
  zoneId: number,
  id: number | string,
): Promise<FavoriteResponse> {
  const numericId = Number(id);
  const favs = await load(zoneId);
  const removed = favs.items.find((f) => f.id === numericId);
  favs.items = favs.items.filter((f) => f.id !== numericId);
  favs.items.forEach((f, i) => (f.slot = i + 1));
  favs.ts = Date.now();

  logger.info(
    `[favorites][zone:${zoneId}] Deleted favorite ${removed?.name ?? numericId}`,
  );
  await save(zoneId, favs);
  return favs;
}

/**
 * Reorders the favorites list by updating slot order
 * based on an array of favorite IDs.
 * @param zoneId - Zone to reorder.
 * @param newOrder - Ordered list of favorite IDs representing the new order.
 * @returns The updated {@link FavoriteResponse} after reordering.
 */
export async function reorderRoomFavorites(
  zoneId: number,
  newOrder: number[],
): Promise<FavoriteResponse> {
  const favs = await load(zoneId);
  const byId = new Map(favs.items.map((f) => [f.id, f]));
  const reordered = newOrder
    .map((id) => byId.get(id))
    .filter(Boolean) as FavoriteItem[];

  // Append items that weren't explicitly ordered
  for (const f of favs.items) if (!reordered.includes(f)) reordered.push(f);

  reordered.forEach((f, i) => (f.slot = i + 1));
  favs.items = reordered;
  favs.ts = Date.now();

  logger.info(`[favorites][zone:${zoneId}] Reordered favorites`);
  await save(zoneId, favs);
  return favs;
}

/**
 * Updates the ID of a single favorite entry while preserving order.
 * Useful for syncing external ID mappings without renumbering everything.
 * @param zoneId - Zone to update.
 * @param oldId - Current ID of the favorite.
 * @param newId - New ID to assign.
 * @returns The updated {@link FavoriteResponse}.
 */
export async function setRoomFavoritesID(
  zoneId: number,
  oldId: number,
  newId: number,
): Promise<FavoriteResponse> {
  const favs = await load(zoneId);
  const updated = favs.items.map((f) =>
    f.id === oldId ? { ...f, id: newId } : f,
  );
  favs.items = updated;
  favs.ts = Date.now();

  logger.info(`[favorites][zone:${zoneId}] Changed favorite ID ${oldId} → ${newId}`);
  await save(zoneId, favs);
  return favs;
}

/**
 * Copies the favorites list from one zone to one or more destination zones.
 * Existing favorites in destination zones will be overwritten.
 * @param sourceZone - Zone ID to copy from.
 * @param destZones - One or more destination zone IDs.
 */
export async function copyRoomFavorites(
  sourceZone: number,
  destZones: number[],
): Promise<void> {
  const source = await load(sourceZone);
  for (const dest of destZones) {
    if (dest === sourceZone) continue;
    const copy = { ...source, id: String(dest), ts: Date.now() };
    await save(dest, copy);
    logger.info(`[favorites][zone:${sourceZone}] Copied favorites → zone:${dest}`);
  }
}

/**
 * Retrieves a specific favorite by ID, typically for playback.
 * Logs warnings if the item cannot be found.
 * @param zoneId - Zone to search within.
 * @param favoriteId - Numeric ID of the favorite to play.
 * @returns The {@link FavoriteItem} if found, otherwise `undefined`.
 */
export async function getRoomFavoriteForPlayback(
  zoneId: number,
  favoriteId: number,
): Promise<FavoriteItem | undefined> {
  const favs = await load(zoneId);
  const item = favs.items.find((f) => f.id === favoriteId);

  if (!item) {
    logger.warn(`[favorites][zone:${zoneId}] Favorite ${favoriteId} not found for playback`);
  } else {
    logger.debug(`[favorites][zone:${zoneId}] Playback favorite: ${item.name}`);
  }

  return item;
}