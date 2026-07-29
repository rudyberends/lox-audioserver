import { encodeAudiopath } from '@/domain/zones/audiopath';
import { resizeCoverUrl, COVER_ART_NOW_PLAYING_SIZE } from '@/shared/coverArt';
import type { PlaybackMetadata } from '@/application/playback/audioManager';

export type MaMediaRef = {
  type: string | null;
  id: string | null;
  provider: string | null;
};

/** Parse a Music Assistant media reference like `apple_music://track/123` or `spotify:track:abc`. */
export function parseMaMediaRef(mediaId: string): MaMediaRef {
  if (!mediaId) {
    return { type: null, id: null, provider: null };
  }
  if (mediaId.includes('://')) {
    const [scheme, restRaw] = mediaId.split('://');
    const rest = restRaw || '';
    const [maybeType, ...restParts] = rest.split('/');
    const type = maybeType || null;
    const id = restParts.join('/') || null;
    return { type, id, provider: scheme || null };
  }
  const parts = mediaId.split(':');
  if (parts.length >= 3) {
    const provider = parts[0] || null;
    const type = parts[1] || null;
    const id = parts.slice(2).join(':') || null;
    return { type, id, provider };
  }
  return { type: null, id: mediaId || null, provider: null };
}

export function toLoxoneAudiopath(
  mediaId: string | undefined,
  providerId: string,
  typeHint = 'track',
): string | undefined {
  if (!mediaId) {
    return undefined;
  }
  const ref = parseMaMediaRef(mediaId);
  const type = ref.type || typeHint || 'track';
  const raw = ref.id && ref.provider ? `${ref.provider}://${type}/${ref.id}` : mediaId;
  return encodeAudiopath(raw, type, providerId);
}

// All callers build now-playing playback metadata, so covers use the larger tier.
export function extractCover(obj: any): string {
  const size = COVER_ART_NOW_PLAYING_SIZE;
  const images = obj?.metadata?.images || obj?.images || obj?.covers || obj?.artwork;
  if (Array.isArray(images) && images.length) {
    const img = images.find((i: any) => i?.path || i?.url || i?.link) || images[0];
    const path = img?.path || img?.url || img?.link;
    if (typeof path === 'string') {
      return resizeCoverUrl(path, size);
    }
  }
  if (typeof obj?.image === 'string') return resizeCoverUrl(obj.image, size);
  if (typeof obj?.image_url === 'string') return resizeCoverUrl(obj.image_url, size);
  if (typeof obj?.cover === 'string') return resizeCoverUrl(obj.cover, size);
  if (typeof obj?.thumbnail === 'string') return resizeCoverUrl(obj.thumbnail, size);
  return '';
}

/**
 * Extract Loxone-shaped playback metadata from a sendspin/builtin-player frame.
 * Returns null when the message has no recognisable metadata.
 */
export function extractSendspinMetadata(msg: any, providerId: string): PlaybackMetadata | null {
  const payload = msg?.payload ?? msg;
  if (!payload) return null;
  const src =
    payload.metadata ||
    payload.player?.metadata ||
    payload.media ||
    payload.track ||
    payload.item ||
    payload;
  const title =
    src?.title ||
    src?.name ||
    src?.track ||
    src?.media_title ||
    src?.track_name ||
    payload?.title ||
    payload?.name ||
    '';
  const artist =
    src?.artist || src?.artists?.[0]?.name || src?.album_artist || payload?.artist || '';
  const album = src?.album?.name || src?.album || payload?.album || '';
  const cover = extractCover(src);
  const duration =
    typeof src?.duration === 'number' && src.duration > 0
      ? Math.round(src.duration)
      : typeof payload?.duration === 'number' && payload.duration > 0
        ? Math.round(payload.duration)
        : undefined;
  const rawAudiopath =
    typeof src?.media_id === 'string'
      ? src.media_id
      : typeof src?.uri === 'string'
        ? src.uri
        : undefined;
  const audiopath = toLoxoneAudiopath(rawAudiopath, providerId, src?.type || payload?.type || 'track');
  if (!title && !artist && !album && !cover && !audiopath && !duration) {
    return null;
  }
  const meta: PlaybackMetadata = {
    title: title || '',
    artist: artist || '',
    album: album || '',
  };
  if (cover) meta.coverurl = cover;
  if (audiopath) meta.audiopath = audiopath;
  if (duration) meta.duration = duration;
  return meta;
}
