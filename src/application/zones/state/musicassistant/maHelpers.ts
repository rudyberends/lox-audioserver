import type { ZoneConfig } from '@/domain/config/types';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import { AudioType } from '@/domain/loxone/enums';
import { resizeCoverUrl, COVER_ART_NOW_PLAYING_SIZE } from '@/shared/coverArt';

export { findMusicAssistantBridge } from '@/shared/musicassistant/maBridgeResolver';

export type MaCommandAction =
  | 'play'
  | 'pause'
  | 'stop'
  | 'next'
  | 'previous'
  | 'volume'
  | 'position';

export function resolvePrimaryOutput(zone: ZoneConfig): Record<string, unknown> | null {
  if (zone.output && typeof zone.output === 'object') {
    return zone.output as unknown as Record<string, unknown>;
  }
  if (Array.isArray(zone.transports) && zone.transports.length > 0) {
    const first = zone.transports[0];
    if (first && typeof first === 'object') {
      return first as unknown as Record<string, unknown>;
    }
  }
  return null;
}

export function normalizeCommand(command: string): MaCommandAction | null {
  const n = command.trim().toLowerCase();
  if (!n) return null;
  if (n === 'play' || n === 'resume') return 'play';
  if (n === 'pause') return 'pause';
  if (n === 'stop' || n === 'off') return 'stop';
  if (n === 'next' || n === 'queueplus' || n === 'skip') return 'next';
  if (n === 'previous' || n === 'prev' || n === 'queueminus') return 'previous';
  if (n === 'volume' || n === 'volume_set') return 'volume';
  if (n === 'position') return 'position';
  return null;
}

export function clampVolume(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function mapPlaybackState(state: string | null | undefined): LoxoneZoneState['mode'] {
  const token = String(state ?? '').toLowerCase();
  if (token.includes('pause')) return 'pause';
  if (token.includes('play') || token.includes('buffer')) return 'play';
  return 'stop';
}

export function mapRepeatMode(mode: string | null | undefined): number {
  const token = String(mode ?? '').toLowerCase();
  if (token === 'one' || token === 'track') return 1;
  if (token === 'all' || token === 'queue') return 2;
  return 0;
}

export function extractMediaMeta(item: Record<string, unknown>): {
  title: string;
  artist: string;
  album: string;
  cover: string;
  audiotype: number | null;
} {
  // Intentionally no fallback to `item.name`: on a MA player payload that field
  // can be the player's display_name (e.g. "Music Assistant") which then leaks
  // into the Loxone audio_event title while artist/album stay empty.
  const title =
    pickString(item.title) ??
    pickString(item.track) ??
    pickString(item.media_title) ??
    pickString(item.track_name) ??
    '';
  const artist =
    pickString(item.artist) ??
    pickString(item.artists) ??
    pickString(item.album_artist) ??
    '';
  const album = pickString(item.album) ?? '';
  // extractMediaMeta feeds the now-playing snapshot → larger tier.
  const cover = extractCoverUrl(item, COVER_ART_NOW_PLAYING_SIZE);
  const mediaType = (pickString(item.media_type) ?? '').toLowerCase();
  let audiotype: number | null = null;
  if (mediaType.includes('radio')) audiotype = AudioType.Radio;
  else if (mediaType.includes('playlist')) audiotype = AudioType.Playlist;
  else if (mediaType.includes('track')) audiotype = AudioType.File;
  return { title, artist, album, cover, audiotype };
}

export function extractCoverUrl(obj: Record<string, unknown>, targetSize: number): string {
  const candidates: Array<unknown> = [
    pickRecord(obj.metadata)?.images,
    obj.images,
    obj.covers,
    obj.artwork,
  ];
  for (const list of candidates) {
    if (Array.isArray(list) && list.length) {
      const img = list.find((entry) => {
        if (!entry || typeof entry !== 'object') return false;
        const e = entry as Record<string, unknown>;
        return typeof e.path === 'string' || typeof e.url === 'string' || typeof e.link === 'string';
      });
      if (img && typeof img === 'object') {
        const e = img as Record<string, unknown>;
        const url =
          (typeof e.path === 'string' ? e.path : '') ||
          (typeof e.url === 'string' ? e.url : '') ||
          (typeof e.link === 'string' ? e.link : '');
        if (url) return resizeCoverUrl(url, targetSize);
      }
    }
  }
  const direct =
    pickString(obj.image) ??
    pickString(obj.image_url) ??
    pickString(obj.cover) ??
    pickString(obj.thumbnail);
  return direct ? resizeCoverUrl(direct, targetSize) : '';
}

export function pickString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (value && typeof value === 'object' && 'name' in (value as Record<string, unknown>)) {
    const inner = (value as Record<string, unknown>).name;
    if (typeof inner === 'string' && inner.trim()) return inner.trim();
  }
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    if (typeof first === 'string' && first.trim()) return first.trim();
    if (first && typeof first === 'object' && 'name' in first) {
      const inner = (first as Record<string, unknown>).name;
      if (typeof inner === 'string' && inner.trim()) return inner.trim();
    }
  }
  return null;
}

export function pickNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

export function pickBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  return fallback;
}

export function pickRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function mergeRecord(
  prev: Record<string, unknown> | null,
  next: Record<string, unknown>,
): Record<string, unknown> {
  if (!prev) return { ...next };
  return { ...prev, ...next };
}

/**
 * Strip a leading provider-prefix (e.g. `ap`, `up`, `airplay-`, `chromecast-`)
 * from a MA player id and return the remaining hex/MAC tail. Used to compare
 * the same physical device exposed under multiple wrapper ids.
 */
export function idSuffix(id: string): string {
  const lower = id.toLowerCase();
  const m = lower.match(/[0-9a-f]{8,}$/);
  return m ? m[0] : '';
}

export function containsMember(value: unknown, target: string): boolean {
  if (!Array.isArray(value)) return false;
  const t = target.toLowerCase();
  const tSuffix = idSuffix(t);
  return value.some((entry) => {
    let id = '';
    if (typeof entry === 'string') id = entry;
    else if (entry && typeof entry === 'object') {
      const r = entry as Record<string, unknown>;
      id =
        (typeof r.player_id === 'string' ? r.player_id : '') ||
        (typeof r.id === 'string' ? r.id : '');
    }
    if (!id) return false;
    const lower = id.toLowerCase();
    if (lower === t) return true;
    return tSuffix.length > 0 && idSuffix(lower) === tSuffix;
  });
}
