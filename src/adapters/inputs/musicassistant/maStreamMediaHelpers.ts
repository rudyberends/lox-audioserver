import { encodeAudiopath } from '@/domain/loxone/audiopath';
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

export function resizeCover(url: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.pathname.includes('imageproxy') && !parsed.searchParams.has('size')) {
      parsed.searchParams.set('size', '256');
      return parsed.toString();
    }
    if (parsed.hostname.includes('mzstatic.com')) {
      parsed.pathname = parsed.pathname.replace(/\/(\d{2,5})x\1bb\.jpg/i, '/256x256bb.jpg');
      return parsed.toString();
    }
  } catch {
    /* ignore */
  }
  return url;
}

export function extractCover(obj: any): string {
  const images = obj?.metadata?.images || obj?.images || obj?.covers || obj?.artwork;
  if (Array.isArray(images) && images.length) {
    const img = images.find((i: any) => i?.path || i?.url || i?.link) || images[0];
    const path = img?.path || img?.url || img?.link;
    if (typeof path === 'string') {
      return resizeCover(path);
    }
  }
  if (typeof obj?.image === 'string') return resizeCover(obj.image);
  if (typeof obj?.image_url === 'string') return resizeCover(obj.image_url);
  if (typeof obj?.cover === 'string') return resizeCover(obj.cover);
  if (typeof obj?.thumbnail === 'string') return resizeCover(obj.thumbnail);
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
