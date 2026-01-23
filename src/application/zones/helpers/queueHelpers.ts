import { inferAudiotype } from '@/domain/loxone/audiopath';
import type { PlaybackMetadata } from '@/application/playback/audioManager';
import type { ContentFolderItem } from '@/ports/ContentTypes';

export function normalizeSpotifyAudiopath(value: string): string {
  if (!value) return value;
  let cleaned = value.trim().replace('spotify://', 'spotify:');
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    /* ignore */
  }
  cleaned = cleaned.replace(/\]+$/, '').replace(/\/+$/, '');
  // Preserve bridge-prefixed providers (e.g., spotify@bridge-<provider>-id:...).
  if (/^spotify@bridge-[^:]+:/i.test(cleaned)) {
    return cleaned;
  }
  if (/musicassistant/i.test(cleaned)) {
    return cleaned;
  }
  if (/applemusic/i.test(cleaned)) {
    return cleaned;
  }
  if (/deezer/i.test(cleaned)) {
    return cleaned;
  }
  if (/tidal/i.test(cleaned)) {
    return cleaned;
  }
  if (cleaned.startsWith('spotify:') && !cleaned.startsWith('spotify@')) {
    const bareIdMatch = /^spotify:([A-Za-z0-9]{22})$/i.exec(cleaned);
    if (bareIdMatch) {
      return `spotify:track:${bareIdMatch[1]}`;
    }
    return cleaned;
  }
  if (cleaned.startsWith('spotify@')) {
    const withoutPrefix = cleaned.replace(/^spotify@/i, 'spotify:');
    const parts = withoutPrefix.split(':').filter(Boolean);
    const knownTypes = new Set(['track', 'album', 'playlist', 'episode', 'show', 'artist']);
    const typeIndex = parts.findIndex((part) => knownTypes.has(part.toLowerCase()));
    if (typeIndex >= 0) {
      return `spotify:${parts.slice(typeIndex).join(':')}`;
    }
    return `spotify:${parts.slice(1).join(':')}`;
  }
  return cleaned;
}

export function sanitizeStation(station: string | undefined, audiopath: string): string {
  if (!station) return '';
  const trimmed = station.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (audiopath.startsWith('library:')) {
    return '';
  }
  if (normalizeSpotifyAudiopath(trimmed) === normalizeSpotifyAudiopath(audiopath)) {
    return '';
  }
  if (lower.startsWith('spotify:track') || lower.startsWith('spotify@') || /^[a-z0-9]{16,}$/i.test(trimmed)) {
    return '';
  }
  return trimmed;
}

export function parseSpotifyUser(audiopath: string): string {
  const match = /^spotify@([^:]+):/i.exec(audiopath);
  return match?.[1] ?? 'nouser';
}

export function generateQueueId(): string {
  return Math.random().toString(16).slice(2, 14);
}

export function createQueueItem(
  uri: string,
  zoneName: string,
  metadata?: PlaybackMetadata,
  audioType = 0,
  defaultSpotifyUserId?: string | null,
): QueueItem {
  const normalizedUri = normalizeSpotifyAudiopath(uri);
  const inferredType =
    audioType && audioType > 0
      ? audioType
      : normalizedUri.toLowerCase().includes('musicassistant')
        ? 5
        : inferAudiotype(normalizedUri);
  const providedTitle = (metadata?.title ?? '').trim();
  const title = providedTitle && !isUriLike(providedTitle) ? providedTitle : zoneName;
  const metaUser = (metadata as any)?.user as string | undefined;
  const metaUnique = (metadata as any)?.unique_id as string | undefined;
  const normalizedUnique = metaUnique ? normalizeSpotifyAudiopath(metaUnique) : undefined;
  const userFromUri =
    uri.startsWith('spotify@')
      ? parseSpotifyUser(uri)
      : normalizedUri.startsWith('spotify@')
        ? parseSpotifyUser(normalizedUri)
        : null;
  const defaultSpotifyUser =
    normalizedUri.startsWith('spotify:') || normalizedUri.startsWith('spotify@')
      ? userFromUri || defaultSpotifyUserId || null
      : null;
  const user = metaUser && metaUser !== 'nouser' ? metaUser : defaultSpotifyUser ?? 'nouser';
  const isLineIn = normalizedUri.toLowerCase().startsWith('linein:');
  const duration =
    typeof metadata?.duration === 'number' && metadata.duration > 0
      ? Math.round(metadata.duration)
      : inferredType === 1 || inferredType === 3 || isLineIn
        ? 0
        : 120;
  const station = sanitizeStation(metadata?.station, normalizedUri);
  return {
    album: metadata?.album ?? '',
    artist: metadata?.artist ?? '',
    audiopath: normalizedUri,
    audiotype: inferredType,
    coverurl: metadata?.coverurl ?? '',
    duration,
    qindex: 0,
    station,
    title: title || zoneName,
    unique_id:
      normalizedUnique && !normalizedUnique.startsWith('spotify@')
        ? normalizedUnique
        : generateQueueId(),
    user,
  };
}

export async function mapFolderItemsToQueue(
  items: ContentFolderItem[],
  zoneName: string,
  audioType: number,
  user: string,
  station?: string,
  defaultSpotifyUserId?: string | null,
): Promise<QueueItem[]> {
  return items.map((item) => ({
    album: item.album ?? item.owner ?? '',
    artist: item.artist ?? item.owner ?? '',
    audiopath: normalizeSpotifyAudiopath(item.audiopath ?? item.id ?? ''),
    audiotype: audioType,
    coverurl: item.coverurl ?? item.thumbnail ?? '',
    duration: Math.round(
      (Number((item as any).duration ?? 0) ?? 0) > 0
        ? Number((item as any).duration ?? 0)
        : audioType === 1
          ? 0
          : 120,
    ),
    qindex: 0,
    station: audioType === 1 || audioType === 4 ? station ?? '' : '',
    title: item.title ?? item.name ?? zoneName,
    unique_id: generateQueueId(),
    user:
      (() => {
        const ap = item.audiopath ?? item.id ?? '';
        if (ap.startsWith('library:')) {
          return 'nouser';
        }
        if (user && user !== 'nouser') {
          return user;
        }
        if (item.owner_id && item.owner_id !== 'nouser') {
          return item.owner_id;
        }
        return defaultSpotifyUserId ?? 'nouser';
      })(),
  }));
}

function isUriLike(value: string | undefined): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return lower.startsWith('spotify:') || lower.startsWith('spotify@') || /^[A-Za-z0-9]{16,}$/.test(value.trim());
}

// Local type import to avoid circular dependencies.
import type { QueueItem } from '@/application/zones/zoneManager';
