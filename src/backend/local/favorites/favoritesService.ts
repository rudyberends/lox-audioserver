import { promises as fs } from 'fs';
import path from 'path';
import logger from '../../../utils/troxorlogger';
import { FavoriteItem, FavoriteResponse, MediaFolderItem, PlaylistItem, RadioFolderItem } from '../../provider/types';
import { getMediaProvider } from '../../provider/factory';
import { parseIdentifier, normalizeMediaUri, denormalizeMediaUri } from '../../provider/musicAssistant/utils';
import { broadcastEvent } from '../../../http/broadcastEvent';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const FAVORITES_DIR = path.join(DATA_DIR, 'favorites');
const BASE_DELTA = 1_000_000;
const BASE_FAVORITE_ZONE = 1 * BASE_DELTA;

type InternalFavoriteItem = FavoriteItem & { sourceId?: string };
type InternalFavoriteResponse = FavoriteResponse & { items: InternalFavoriteItem[]; ts: number };
type FavoriteMetadata = Partial<InternalFavoriteItem>;

const metadataCache = new Map<string, FavoriteMetadata | null>();

/**
 * Return favorites for a zone, applying pagination while keeping stored data intact.
 */
export async function getRoomFavorites(
  zoneId: number,
  start: number,
  limit: number,
): Promise<FavoriteResponse> {
  const favorites = await loadFavorites(zoneId);
  const offset = Math.max(0, start);
  const boundedLimit = limit > 0 ? limit : favorites.items.length;
  const items = favorites.items.slice(offset, offset + boundedLimit);

  return {
    ...favorites,
    start: offset,
    totalitems: favorites.items.length,
    items,
  };
}

/**
 * Append a favorite for the given zone. Missing identifiers are derived from the title.
 */
export async function addRoomFavorite(
  zoneId: number,
  title: string,
  encodedId?: string,
): Promise<FavoriteResponse> {
  const favorites = await loadFavorites(zoneId);
  const trimmedId = encodedId?.trim();
  const sourceId =
    extractSourceId(trimmedId) ??
    (trimmedId && trimmedId.length > 0 ? trimmedId : buildFallbackSourceId(zoneId, title));
  const normalizedTitle = title?.trim() ? title.trim() : sourceId;

  const baseItem: InternalFavoriteItem = {
    id: 0,
    slot: 0,
    name: normalizedTitle,
    title: normalizedTitle,
    plus: false,
    audiopath: sourceId,
    type: '',
    provider: inferProvider(sourceId),
    service: 'library',
    rawId: trimmedId ?? '',
    sourceId,
  };
  const enrichedItem = await enrichFavoriteMetadata(baseItem);

  const appended: InternalFavoriteResponse = {
    ...favorites,
    items: [
      ...favorites.items,
      enrichedItem,
    ],
    ts: Date.now(),
  };

  return persistFavorites(zoneId, appended);
}

/**
 * Remove a favorite identified by its id.
 */
export async function deleteRoomFavorite(
  zoneId: number,
  targetId: number | string
): Promise<FavoriteResponse> {
  const favorites = await loadFavorites(zoneId);
  const id = Number(targetId);
  if (Number.isNaN(id)) return favorites;

  const prunedItems = favorites.items.filter(
    (item) => item.id !== id
  );

  const filtered: InternalFavoriteResponse = {
    ...favorites,
    items: prunedItems,
    ts: Date.now(),
  };

  return persistFavorites(zoneId, filtered);
}

/**
 * Reorder favorites based on the provided encoded identifiers.
 */
export async function reorderRoomFavorites(
  zoneId: number,
  orderedIds: string[],
): Promise<FavoriteResponse> {
  const favorites = await loadFavorites(zoneId);
  if (!orderedIds.length) return favorites;

  const itemsById = new Map<string, InternalFavoriteItem>();
  favorites.items.forEach((item) => itemsById.set(getItemKey(item), item));
  const reordered: InternalFavoriteItem[] = [];

  for (const encoded of orderedIds) {
    const candidate = itemsById.get(encoded);
    if (candidate) {
      reordered.push(candidate);
      itemsById.delete(encoded);
    }
  }

  // Append items that were not mentioned in the reorder payload, keeping their current order.
  const remaining = favorites.items.filter((item) => itemsById.has(getItemKey(item))) as InternalFavoriteItem[];
  const updated: InternalFavoriteResponse = {
    ...favorites,
    items: [...reordered, ...remaining],
    ts: Date.now(),
  };

  return persistFavorites(zoneId, updated);
}

/**
 * Toggle the "plus" flag for a given favorite.
 */
export async function setRoomFavoritePlus(
  zoneId: number,
  encodedId: string,
  plus: boolean,
): Promise<FavoriteResponse> {
  const favorites = await loadFavorites(zoneId);
  const updatedItems = favorites.items.map((item) =>
    getItemKey(item) === encodedId ? { ...item, plus } : item,
  ) as InternalFavoriteItem[];

  return persistFavorites(zoneId, {
    ...favorites,
    items: updatedItems,
    ts: Date.now(),
  });
}

/**
 * Copy favorites from a source zone to one or more destination zones.
 */
export async function copyRoomFavorites(sourceZoneId: number, destinationZoneIds: number[]): Promise<void> {
  if (!destinationZoneIds.length) return;

  const sourceFavorites = await loadFavorites(sourceZoneId);

  for (const destinationId of destinationZoneIds) {
    if (!Number.isFinite(destinationId) || destinationId <= 0) continue;
    if (destinationId === sourceZoneId) continue;

    const duplicate: InternalFavoriteResponse = {
      id: String(destinationId),
      name: sourceFavorites.name,
      start: 0,
      totalitems: sourceFavorites.items.length,
      items: sourceFavorites.items.map((item) => ({ ...item })) as InternalFavoriteItem[],
      ts: Date.now(),
    };

    await persistFavorites(destinationId, duplicate);
  }
}

/**
 * Retrieve a favorite item for playback by its numeric identifier.
 */
export async function getRoomFavoriteForPlayback(
  zoneId: number,
  favoriteId: number,
): Promise<FavoriteItem | undefined> {
  const favorites = await loadFavorites(zoneId);
  const match = favorites.items.find(
    (item) => item.id === favoriteId || item.slot === favoriteId,
  );
  if (!match) return undefined;
  const { sourceId, ...rest } = match;
  return { ...rest };
}

/**
 * Ensure the favorites directory exists and return the normalized payload for a zone.
 */
async function loadFavorites(zoneId: number): Promise<InternalFavoriteResponse> {
  await ensureFavoritesDirectory();
  const filePath = getFavoritesFilePath(zoneId);
  const raw = await readFavoritesFile(filePath);
  let shouldPersist = !raw;

  const normalized = normalizeFavorites(zoneId, raw);
  if (raw) {
    shouldPersist = shouldPersist || JSON.stringify(raw) !== JSON.stringify(normalized);
  }

  const { value, changed } = await enrichFavoritesMetadata(normalized);
  if (changed || shouldPersist) {
    await writeFavoritesFile(filePath, value);
  }

  return value;
}

async function persistFavorites(zoneId: number, payload: InternalFavoriteResponse): Promise<FavoriteResponse> {
  await ensureFavoritesDirectory();
  const normalized = normalizeFavorites(zoneId, payload);
  const { value } = await enrichFavoritesMetadata(normalized);
  await writeFavoritesFile(getFavoritesFilePath(zoneId), value);
  const event = {
    roomfavchanged_event: [
      {
        count: value.items?.length ?? 0,
        playerid: zoneId,
      },
    ],
  };

  broadcastEvent(JSON.stringify(event));
  return value;
}

function getFavoritesFilePath(zoneId: number): string {
  return path.join(FAVORITES_DIR, `${zoneId}.json`);
}

async function ensureFavoritesDirectory(): Promise<void> {
  try {
    await fs.mkdir(FAVORITES_DIR, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[favorites] Failed to ensure favorites directory: ${message}`);
    throw error;
  }
}

async function readFavoritesFile(filePath: string): Promise<FavoriteResponse | undefined> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return undefined;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[favorites] Failed to read favorites for ${filePath}: ${message}`);
    throw error;
  }
}

async function writeFavoritesFile(
  filePath: string,
  payload: InternalFavoriteResponse,
): Promise<void> {
  const data = JSON.stringify(payload, null, 2);
  try {
    await fs.writeFile(filePath, data, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[favorites] Failed to write favorites for ${filePath}: ${message}`);
    throw error;
  }
}

function normalizeFavorites(
  zoneId: number,
  payload: FavoriteResponse | InternalFavoriteResponse | undefined,
): InternalFavoriteResponse {
  const items = Array.isArray(payload?.items) ? payload!.items : [];

  const normalizedItems = items
    .filter((candidate): candidate is InternalFavoriteItem | FavoriteItem => !!candidate)
    .map((item, index) => normalizeFavoriteItem(item as Record<string, unknown>, index + 1));

  return {
    id: extractIdentifier(payload?.id, zoneId),
    name: extractName(payload?.name),
    start: 0,
    totalitems: normalizedItems.length,
    items: normalizedItems,
    ts: typeof payload?.ts === 'number' ? payload.ts : Date.now(),
  };
}

function normalizeFavoriteItem(raw: Record<string, unknown>, slot: number): InternalFavoriteItem {
  const fallbackTitle = `Favorite ${slot}`;
  const sourceId = extractSourceIdFromItem(raw, fallbackTitle);
  const name = extractString(raw.name) || extractString(raw.title) || fallbackTitle;
  const title = extractString(raw.title) || name;
  const provider = extractString(raw.provider) || inferProvider(sourceId);
  const service = extractString(raw.service) || 'library';
  const type = extractString(raw.type) || inferFavoriteType(sourceId);
  const audiopath = extractString(raw.audiopath) || sourceId;
  const coverurl = extractString(raw.coverurl);
  const duration = extractNumber(raw.duration);
  const album = extractString(raw.album);
  const artist = extractString(raw.artist);
  const station = extractString(raw.station);
  const owner = extractString(raw.owner);
  const username = extractString(raw.username);
  const serviceField = extractString(raw.service);
  const rawId = encodeFavoriteIdentifier(sourceId, slot);
  const favoriteId = BASE_FAVORITE_ZONE + (slot - 1);

  const normalized: InternalFavoriteItem = {
    ...(raw as FavoriteItem),
    id: favoriteId,
    slot,
    name,
    title,
    plus: Boolean(raw.plus),
    audiopath,
    type,
    provider,
    service: serviceField || service,
    rawId,
    sourceId,
  };

  if (coverurl !== undefined) normalized.coverurl = coverurl;
  if (duration !== undefined) normalized.duration = duration;
  if (album !== undefined) normalized.album = album;
  if (artist !== undefined) normalized.artist = artist;
  if (station !== undefined) normalized.station = station;
  if (owner !== undefined) normalized.owner = owner;
  if (username !== undefined) normalized.username = username;

  return normalized;
}

function extractIdentifier(id: unknown, zoneId: number): string {
  if (typeof id === 'string' && id.trim()) return id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return String(zoneId);
}

function extractName(name: unknown): string {
  if (typeof name === 'string' && name.trim()) return name.trim();
  return 'Favorites';
}

function extractString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}

function extractNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function extractSourceId(encodedId?: string): string | undefined {
  if (!encodedId) return undefined;
  const decoded = decodeFavoriteIdentifier(encodedId);
  if (decoded?.sourceId) return decoded.sourceId;
  return undefined;
}

function extractSourceIdFromItem(raw: Record<string, unknown>, fallback: string): string {
  if (typeof raw.sourceId === 'string' && raw.sourceId.trim()) return raw.sourceId.trim();
  if (typeof raw.audiopath === 'string' && raw.audiopath.trim()) return raw.audiopath.trim();
  if (typeof raw.rawId === 'string' && raw.rawId.trim()) {
    const decoded = decodeFavoriteIdentifier(raw.rawId);
    if (decoded?.sourceId) return decoded.sourceId;
  }
  if (typeof raw.station === 'string' && raw.station.trim()) return raw.station.trim();
  if (typeof raw.title === 'string' && raw.title.trim()) return raw.title.trim();
  return fallback;
}

function buildFallbackSourceId(zoneId: number, title: string): string {
  const slug = title
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = slug && slug.length > 0 ? slug : `favorite-${Date.now()}`;
  return `zone:${zoneId}:${base}`;
}

function inferProvider(sourceId: string): string {
  if (/^spotify:/i.test(sourceId)) return 'spotify';
  if (/^tidal:/i.test(sourceId)) return 'tidal';
  if (/^radio:/i.test(sourceId)) return 'radio';
  if (/^deezer:/i.test(sourceId)) return 'deezer';
  return 'library';
}

function inferFavoriteType(sourceId: string): string {
  if (/^spotify:playlist:/i.test(sourceId)) return 'playlist';
  if (/^spotify:(track|song):/i.test(sourceId)) return 'library_track';
  if (/^radio:/i.test(sourceId)) return 'radio';
  return 'library_track';
}

function getItemKey(item: InternalFavoriteItem): string {
  if (typeof item.rawId === 'string' && item.rawId.length > 0) {
    return item.rawId;
  }
  const fallbackSource =
    item.sourceId && item.sourceId.length > 0
      ? item.sourceId
      : typeof item.audiopath === 'string' && item.audiopath.length > 0
        ? item.audiopath
        : typeof item.title === 'string' && item.title.length > 0
          ? item.title
          : typeof item.name === 'string' && item.name.length > 0
            ? item.name
            : `favorite-${item.slot}`;
  return encodeFavoriteIdentifier(fallbackSource, item.slot);
}

function needsMetadataEnrichment(item: InternalFavoriteItem): boolean {
  if (!item.coverurl) return true;
  if (!item.artist) return true;
  if (!item.album) return true;
  return false;
}

async function enrichFavoritesMetadata(
  payload: InternalFavoriteResponse,
): Promise<{ value: InternalFavoriteResponse; changed: boolean }> {
  let changed = false;
  const items: InternalFavoriteItem[] = [];

  for (const item of payload.items) {
    if (!needsMetadataEnrichment(item)) {
      items.push(item);
      continue;
    }

    const enriched = await enrichFavoriteMetadata(item);
    if (enriched !== item) {
      changed = true;
      items.push(enriched);
    } else {
      items.push(item);
    }
  }

  if (!changed) {
    return { value: payload, changed: false };
  }

  return {
    value: {
      ...payload,
      items,
      ts: Date.now(),
    },
    changed: true,
  };
}

async function enrichFavoriteMetadata(item: InternalFavoriteItem): Promise<InternalFavoriteItem> {
  const cacheKey = item.sourceId || item.audiopath || item.rawId;
  if (!cacheKey) return item;

  const cached = metadataCache.get(cacheKey);
  if (cached !== undefined) {
    if (cached === null) return item;
    return mergeFavoriteMetadata(item, cached);
  }

  const metadata = await fetchFavoriteMetadata(item);
  metadataCache.set(cacheKey, metadata ?? null);
  if (!metadata) return item;
  return mergeFavoriteMetadata(item, metadata);
}

function mergeFavoriteMetadata(
  original: InternalFavoriteItem,
  metadata: FavoriteMetadata,
): InternalFavoriteItem {
  let updated = false;
  const merged: InternalFavoriteItem = { ...original };

  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue;
    if ((merged as Record<string, unknown>)[key] === value) continue;
    (merged as Record<string, unknown>)[key] = value;
    updated = true;
  }

  return updated ? merged : original;
}

async function fetchFavoriteMetadata(item: InternalFavoriteItem): Promise<FavoriteMetadata | undefined> {
  const provider = getMediaProvider();
  const identifier = item.sourceId || item.audiopath || item.rawId;
  if (!identifier) return undefined;

  const candidates = buildIdentifierCandidates(identifier);

  for (const candidate of candidates) {
    const parsed = parseIdentifier(candidate);
    let resolved: MediaFolderItem | PlaylistItem | RadioFolderItem | undefined;

    try {
      switch ((parsed.kind || '').toLowerCase()) {
        case 'track':
        case 'album':
        case 'artist':
          if (provider.resolveMediaItem) {
            resolved =
              (await provider.resolveMediaItem('', candidate)) ??
              (candidate.startsWith('library:')
                ? await provider.resolveMediaItem(parsed.kind ?? '', candidate)
                : undefined);
          }
          break;
        case 'playlist':
          if (provider.resolvePlaylist && parsed.itemId) {
            resolved = await provider.resolvePlaylist(
              parsed.provider ?? item.provider ?? 'library',
              parsed.itemId,
            );
          }
          break;
        case 'radio':
          if (provider.resolveStation && parsed.itemId) {
            resolved = await provider.resolveStation(parsed.provider ?? item.provider ?? 'radio', parsed.itemId);
          }
          break;
        default:
          if (provider.resolveMediaItem) {
            resolved = await provider.resolveMediaItem('', candidate);
          }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(`[favorites] Metadata lookup failed for ${candidate}: ${message}`);
      resolved = undefined;
    }

    if (!resolved) {
      continue;
    }

    const metadata: FavoriteMetadata = {};
    const resolvedAny = resolved as unknown as Record<string, unknown>;

    const cover = pickFirstString(resolvedAny, ['coverurlHighRes', 'coverurl', 'thumbnail']);
    if (cover) metadata.coverurl = cover;

    const artist = pickFirstString(resolvedAny, ['artist']);
    if (artist) metadata.artist = artist;

    const album = pickFirstString(resolvedAny, ['album']);
    if (album) metadata.album = album;

    const owner = pickFirstString(resolvedAny, ['owner']);
    if (owner) metadata.owner = owner;

    const title = pickFirstString(resolvedAny, ['title']);
    if (title) metadata.title = title;

    const name = pickFirstString(resolvedAny, ['name']);
    if (name) metadata.name = name;

    const duration = resolvedAny.duration;
    if (typeof duration === 'number' && Number.isFinite(duration)) metadata.duration = duration;

    const providerName = pickFirstString(resolvedAny, ['provider']);
    if (providerName) metadata.provider = providerName;

    const serviceName = pickFirstString(resolvedAny, ['service']);
    if (serviceName) metadata.service = serviceName;

    const audiopath = pickFirstString(resolvedAny, ['audiopath', 'id']);
    if (audiopath && (!item.audiopath || item.audiopath === item.sourceId)) {
      metadata.audiopath = audiopath;
    }

    const typeValue = resolvedAny.type;
    if (typeof typeValue === 'string' && typeValue.trim()) metadata.type = typeValue;

    const station = pickFirstString(resolvedAny, ['station']);
    if (station) metadata.station = station;

    return metadata;
  }

  return undefined;
}

function buildIdentifierCandidates(identifier: string): string[] {
  const values = new Set<string>();
  const trimmed = identifier.trim();
  if (!trimmed) return [];
  values.add(trimmed);

  const withoutQuery = trimmed.split('?')[0];
  values.add(withoutQuery);

  const normalized = normalizeMediaUri(trimmed);
  values.add(normalized);

  const libraryUrl = toLibraryUrl(normalized);
  if (libraryUrl) values.add(libraryUrl);

  const denormalized = denormalizeMediaUri(normalized);
  if (denormalized && denormalized !== normalized) {
    values.add(denormalized);
  }

  return Array.from(values).filter((value) => value.length > 0);
}

function toLibraryUrl(value: string): string | undefined {
  const lower = value.toLowerCase();
  if (lower.startsWith('library://')) {
    return value;
  }
  if (lower.startsWith('library:')) {
    const rest = value.slice('library:'.length).replace(/:/g, '/');
    return `library://${rest}`;
  }
  return undefined;
}

function pickFirstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function encodeFavoriteIdentifier(sourceId: string, slot: number): string {
  const payload = JSON.stringify([sourceId, BASE_FAVORITE_ZONE + (slot - 1)]);
  const base64 = Buffer.from(payload).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeFavoriteIdentifier(
  encoded: string,
): { sourceId: string; favoriteId?: number } | undefined {
  if (!encoded) return undefined;
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  try {
    const raw = Buffer.from(normalized + '='.repeat(padLength), 'base64').toString('utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const source = typeof parsed[0] === 'string' ? parsed[0] : String(parsed[0] ?? '');
      const favoriteId =
        typeof parsed[1] === 'number' && Number.isFinite(parsed[1])
          ? parsed[1]
          : undefined;
      return { sourceId: source, favoriteId };
    }
    if (typeof parsed === 'string') {
      return { sourceId: parsed, favoriteId: undefined };
    }
  } catch (error) {
    // ignore decode failures and fall back to undefined
  }
  return undefined;
}
