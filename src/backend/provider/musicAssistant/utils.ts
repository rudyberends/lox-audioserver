import logger from '../../../utils/troxorlogger';

export type MediaKeyKind =
  | 'albums'
  | 'artists'
  | 'tracks'
  | 'album'
  | 'artist'
  | 'track'
  | 'playlist'
  | 'radio';

export interface ParsedKey {
  kind: MediaKeyKind | string;
  provider?: string;
  itemId?: string;
}

export function safeNumber(value: any, fallback?: number): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function parseIdentifier(value: string): ParsedKey {
  const normalized = (value ?? '').trim();
  if (!normalized) {
    return { kind: normalized };
  }

  const library = parseLibraryIdentifier(normalized);
  if (library) {
    return library;
  }

  const playlist = parsePlaylistIdentifier(normalized);
  if (playlist) {
    return playlist;
  }

  return parseCompositeIdentifier(normalized);
}

export function parseLibraryIdentifier(value: string): ParsedKey | undefined {
  if (!value.toLowerCase().startsWith('library://')) {
    return undefined;
  }
  try {
    const url = new URL(value);
    const kind = url.hostname || url.host;
    if (!kind) {
      return undefined;
    }
    const itemId = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const provider = url.searchParams.get('provider') ?? 'library';
    return { kind, provider, itemId };
  } catch {
    return undefined;
  }
}

export function parsePlaylistIdentifier(value: string): ParsedKey | undefined {
  if (!value.toLowerCase().startsWith('playlist:')) {
    return undefined;
  }

  const [base, query = ''] = value.split('?', 2);
  const idPart = base.slice('playlist:'.length);
  const params = new URLSearchParams(query);
  let provider = params.get('provider') ?? params.get('instance_id') ?? undefined;

  let itemId: string;
  if (!provider) {
    const segments = idPart.split(':');
    if (segments.length >= 2) {
      provider = decodeSegment(segments[0]);
      const encodedId = segments.slice(1).join(':');
      itemId = decodeURIComponent(encodedId);
    } else {
      itemId = decodeURIComponent(idPart);
    }
  } else {
    itemId = decodeURIComponent(idPart);
  }

  return { kind: 'playlist', provider, itemId };
}

export function parseCompositeIdentifier(value: string): ParsedKey {
  const parts = value.split(':');
  const head = (parts[0] ?? '').trim().toLowerCase();
  if (!head) {
    return { kind: value };
  }

  if (head === 'library' && parts.length >= 3) {
    const provider = decodeSegment(parts[1]);
    const kind = decodeSegment(parts[2]);
    const itemId =
      parts.length > 3 ? decodeSegment(parts.slice(3).join(':')) : undefined;
    return { kind, provider, itemId };
  }

  if (head === 'radio' && parts.length >= 3) {
    const provider = decodeSegment(parts[1]);
    const itemId = decodeSegment(parts.slice(2).join(':'));
    return { kind: 'radio', provider, itemId };
  }

  if (head === 'playlist' && parts.length >= 3) {
    const provider = decodeSegment(parts[1]);
    const itemId = decodeSegment(parts.slice(2).join(':'));
    return { kind: 'playlist', provider, itemId };
  }

  const provider = parts.length >= 2 ? decodeSegment(parts[1]) : undefined;
  const itemId =
    parts.length >= 3 ? decodeSegment(parts.slice(2).join(':')) : undefined;
  return { kind: head, provider, itemId };
}

export function toPlaylistCommandUri(
  value: string | undefined,
  fallbackProvider?: string,
  fallbackId?: string,
): string {
  const parsed = value ? parseIdentifier(value) : { kind: '', provider: undefined, itemId: undefined };

  if (parsed.kind === 'playlist' && parsed.itemId) {
    return buildPlaylistUri(parsed.itemId, parsed.provider ?? fallbackProvider);
  }

  if (fallbackId) {
    return buildPlaylistUri(fallbackId, parsed.provider ?? fallbackProvider);
  }

  if (value && value.toLowerCase().startsWith('playlist:')) {
    return value;
  }

  return buildPlaylistUri('', fallbackProvider);
}

export function normalizeItemKey(value: string): string {
  if (!value) return value;
  const trimmed = value.trim();
  if (!trimmed.includes('/')) return trimmed;
  const segments = trimmed.split('/').filter(Boolean);
  return segments.join(':');
}

export function buildLibraryUri(
  type: string,
  id: string,
  provider?: string,
): string {
  const safeType = encodeURIComponent(type.replace(/s$/, ''));
  const safeId = encodeURIComponent(id);
  const base = `library://${safeType}/${safeId}`;
  const uri = provider ? `${base}?provider=${encodeURIComponent(provider)}` : base;
  return normalizeMediaUri(uri);
}

export function buildPlaylistUri(id: string, provider?: string): string {
  if (!id) return '';
  if (id.includes('://')) return id;
  const safeId = encodeSegment(id);
  if (!provider) {
    return `playlist:${safeId}`;
  }
  return `playlist:${encodeSegment(provider)}:${safeId}`;
}

export function buildLibraryKey(
  kind: string,
  provider?: string,
  itemId?: string,
  fallbackProvider = 'musicassistant',
): string {
  const providerSegment = encodeSegment(provider ?? fallbackProvider);
  const kindSegment = encodeSegment(kind);
  if (!itemId) {
    return `library:${providerSegment}:${kindSegment}`;
  }
  return `library:${providerSegment}:${kindSegment}:${encodeSegment(itemId)}`;
}

export function buildPlaylistKey(
  provider: string | undefined,
  itemId: string,
): string {
  return buildPlaylistUri(itemId, provider);
}

export function buildRadioKey(
  provider?: string,
  itemId?: string,
  fallbackProvider = 'musicassistant',
): string {
  const providerSegment = encodeSegment(provider ?? fallbackProvider);
  const itemSegment = encodeSegment(itemId ?? '');
  return itemSegment ? `radio:${providerSegment}:${itemSegment}` : `radio:${providerSegment}`;
}

export function encodeSegment(value: string): string {
  return encodeURIComponent(value ?? '');
}

export function decodeSegment(value: string): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function extractProvider(item: any): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const candidates = [
    item.provider_instance_id,
    item.provider,
    item.provider_instance,
    item.provider_domain,
    item.provider_instance_id_or_domain,
    item.providerMapping?.provider_instance_id,
    item.provider_mapping?.provider_instance_id,
    Array.isArray(item.provider_mappings)
      ? item.provider_mappings[0]?.provider_instance_id
      : undefined,
  ];
  for (const valueCandidate of candidates) {
    if (typeof valueCandidate === 'string' && valueCandidate.trim()) {
      return valueCandidate.trim();
    }
  }
  return undefined;
}

export function extractItemId(item: any): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const candidates = [
    item.item_id,
    item.media_item_id,
    item.media_item,
    item.id,
    item.uri,
    item.media_uri,
    item.playable_id,
    item.provider_mapping?.item_id,
    item.providerMapping?.item_id,
    Array.isArray(item.provider_mappings) ? item.provider_mappings[0]?.item_id : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

export function normalizeMediaUri(uri: string): string {
  if (typeof uri !== 'string' || uri.length === 0) {
    return '';
  }

  const [core, queryString = ''] = uri.split('?', 2);
  const lowerCore = core.toLowerCase();
  let normalized = core;

  if (lowerCore.startsWith('apple_music://track/')) {
    const id = core.slice('apple_music://track/'.length);
    normalized = `library:local:track:apple_music:${id}`;
  } else if (lowerCore.startsWith('applemusic://track/')) {
    const id = core.slice('applemusic://track/'.length);
    normalized = `library:local:track:apple_music:${id}`;
  } else if (lowerCore.startsWith('tidal://track/')) {
    const id = core.slice('tidal://track/'.length);
    normalized = `library:local:track:tidal:${id}`;
  } else if (lowerCore.startsWith('deezer://track/')) {
    const id = core.slice('deezer://track/'.length);
    normalized = `library:local:track:deezer:${id}`;
  } else if (lowerCore.startsWith('library://')) {
    const remainder = core.slice('library://'.length);
    if (!remainder) {
      normalized = 'library:local';
    } else {
      normalized = `library:local:${remainder.replace(/\//g, ':')}`;
    }
  } else if (lowerCore.startsWith('library:')) {
    normalized = core;
  }

  if (queryString) {
    const params = new URLSearchParams(queryString);
    const providerParam = params.get('provider');
    if (providerParam) {
      const providerLower = providerParam.toLowerCase();
      if (
        providerLower !== 'local' &&
        normalized.startsWith('library:local:track:') &&
        !normalized.toLowerCase().includes(`:${providerLower}:`)
      ) {
        normalized = `${normalized}:${providerParam}`;
      }
    }
  }

  return normalized;
}

export function denormalizeMediaUri(uri: string): string {
  if (typeof uri !== 'string' || uri.length === 0) {
    return '';
  }
  const lower = uri.toLowerCase();
  if (lower.startsWith('library:local:track:apple_music:')) {
    const id = uri.slice('library:local:track:apple_music:'.length);
    return `apple_music://track/${id}`;
  }
  if (lower.startsWith('library:local:track:tidal:')) {
    const id = uri.slice('library:local:track:tidal:'.length);
    return `tidal://track/${id}`;
  }
  if (lower.startsWith('library:local:track:deezer:')) {
    const id = uri.slice('library:local:track:deezer:'.length);
    return `deezer://track/${id}`;
  }
  if (lower.startsWith('library:local:')) {
    const remainder = uri.slice('library:local:'.length);
    const path = remainder.replace(/:/g, '/');
    return `library://${path}`;
  }
  return uri;
}

export function denormalizePlaylistUri(value: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return '';

  if (trimmed.toLowerCase().startsWith('library://')) {
    return trimmed;
  }

  const parsed = parseIdentifier(trimmed);
  if (parsed.kind === 'playlist' && parsed.itemId) {
    const playlistId = encodeURIComponent(parsed.itemId);
    const provider = parsed.provider && parsed.provider.toLowerCase() !== 'library'
      ? encodeURIComponent(parsed.provider)
      : undefined;
    return provider ? `library://playlist/${playlistId}?provider=${provider}` : `library://playlist/${playlistId}`;
  }

  return denormalizeMediaUri(trimmed);
}

export function extractName(item: any): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const candidates = [
    item.name,
    item.title,
    item.display_name,
    item.label,
    item.album,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

export function extractArtist(item: any): string | undefined {
  if (!item || typeof item !== 'object') return undefined;

  if (typeof item.artist === 'string' && item.artist.trim()) {
    return item.artist.trim();
  }

  const artistName = extractName(item?.artist);
  if (artistName) return artistName;

  const artists = item.artists ?? item.artist_names ?? item.albumartists ?? item.album_artists;
  if (Array.isArray(artists)) {
    const names: string[] = [];
    for (const entry of artists) {
      if (typeof entry === 'string' && entry.trim()) {
        names.push(entry.trim());
      } else if (entry && typeof entry === 'object') {
        const entryName = extractName(entry);
        if (entryName) names.push(entryName);
      }
    }
    if (names.length) {
      return Array.from(new Set(names)).join(', ');
    }
  }

  if (typeof item.artist_str === 'string' && item.artist_str.trim()) {
    return item.artist_str.trim();
  }

  return undefined;
}

export function extractAlbum(item: any): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  if (typeof item.album === 'string' && item.album.trim()) {
    return item.album.trim();
  }
  if (item.album && typeof item.album === 'object') {
    return extractName(item.album);
  }
  if (typeof item.album_name === 'string' && item.album_name.trim()) {
    return item.album_name.trim();
  }
  return undefined;
}

export function extractImage(item: any): string {
  if (!item || typeof item !== 'object') return '';

  const candidates = [
    item.image,
    item.image_url,
    item.imageUrl,
    item.image_path,
    item.imagePath,
    item.cover,
    item.cover_url,
    item.coverUrl,
    item.cover_path,
    item.coverPath,
    item.coverurl,
    item.thumbnail,
    item.thumbnail_url,
    item.thumbnailUrl,
    item.thumbnail_path,
    item.thumbnailPath,
    item.thumb,
    item.picture,
    item.path,
    item.icon,
    item.art,
    item.artwork,
    item.background,
    item.logo,
    item.imageSmall,
    item.imageMedium,
    item.imageLarge,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  const imageArrayCandidates = [
    item.image,
    item.images,
    item.thumbnails,
    item.covers,
    item.media_images,
    item.image_map,
    item.thumbs,
    item.icons,
  ];
  for (const set of imageArrayCandidates) {
    if (Array.isArray(set)) {
      for (const entry of set) {
        if (typeof entry === 'string' && entry.trim()) {
          return entry.trim();
        }
        if (entry && typeof entry === 'object') {
          const urlCandidate =
            entry.url ??
            entry.href ??
            entry.link ??
            entry.src ??
            entry.path ??
            entry.location;
          if (typeof urlCandidate === 'string' && urlCandidate.trim()) {
            return urlCandidate.trim();
          }
        }
      }
    }
  }

  const providerImageCandidates = [
    item?.provider?.image,
    item?.provider?.icon,
    item?.provider_mapping?.image,
    item?.provider_mapping?.icon,
    item?.providerMapping?.image,
    item?.providerMapping?.icon,
  ];
  for (const candidate of providerImageCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  if (item?.metadata && typeof item.metadata === 'object') {
    const nestedCandidates = [
      item.metadata.image,
      item.metadata.cover,
      item.metadata.thumbnail,
      item.metadata.icon,
    ];
    for (const candidate of nestedCandidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
  }

  return '';
}

export function extractUri(
  item: any,
  fallbackType?: string,
  fallbackId?: string,
  provider?: string,
): string | undefined {
  if (!item || typeof item !== 'object') {
    if (typeof item === 'string' && item.trim()) return item.trim();
    return undefined;
  }

  const candidates = [
    item.uri,
    item.media_uri,
    item.media_item_uri,
    item.play_uri,
    item.stream,
    item.stream_url,
    item.audiopath,
    item.url,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  if (fallbackType && fallbackId) {
    return buildLibraryUri(fallbackType, fallbackId, provider);
  }

  return undefined;
}

export function logError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  logger.warn(`[MusicAssistantProvider] ${context} failed – ${message}`);
}
