import type { ZoneConfig } from '@/domain/config/types';
import type { QueueState } from '@/application/zones/zoneManager';
import type { ZoneState } from '@/domain/zones/zoneState';
import { AudioType } from '@/domain/zones/enums';
import { parseServiceNativeAudiopath } from '@/domain/zones/audiopath';
import { getZoneEqualizerBands } from '@/domain/zones/equalizer';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function clampVolumeForZone(zone: ZoneConfig, value: number): number {
  const raw = Number.isFinite(value) ? Number(value) : 0;
  const maxVol =
    typeof zone.volumes?.maxVolume === 'number' && zone.volumes.maxVolume > 0
      ? zone.volumes.maxVolume
      : 100;
  const step = typeof zone.volumes?.volstep === 'number' && zone.volumes.volstep > 0
    ? zone.volumes.volstep
    : null;
  const stepped = step ? Math.round(raw / step) * step : raw;
  return clamp(Math.round(stepped), 0, maxVol);
}

export function getZoneDefaultVolume(zone: ZoneConfig): number {
  const configured =
    typeof zone.volumes?.default === 'number' ? zone.volumes.default : 0;
  return clampVolumeForZone(zone, configured);
}

export function cloneQueueState(queue: QueueState): QueueState {
  return {
    items: queue.items.map((item, idx) => ({ ...item, qindex: idx })),
    shuffle: queue.shuffle,
    repeat: queue.repeat,
    currentIndex: queue.currentIndex,
    authority: queue.authority,
  };
}

export function fallbackTitle(current: string | undefined, zoneName: string): string {
  if (current && !isUriLike(current)) {
    return current;
  }
  return zoneName;
}

export function sanitizeTitle(title: string | undefined, fallback: string): string {
  if (!title) return fallback;
  const lower = title.toLowerCase();
  if (lower.startsWith('spotify:') || lower.startsWith('spotify@')) {
    return fallback;
  }
  // Service-native audiopath (applemusic:playlist:..., tidal:track:..., etc.)
  // must never leak into the displayed title.
  if (parseServiceNativeAudiopath(title)) {
    return fallback;
  }
  if (/^[A-Za-z0-9]{16,}$/i.test(title.trim())) {
    return fallback;
  }
  return title;
}

export function isUriLike(value: string | undefined): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return (
    lower.startsWith('spotify:') ||
    lower.startsWith('spotify@') ||
    parseServiceNativeAudiopath(value) !== null ||
    /^[A-Za-z0-9]{16,}$/.test(value.trim())
  );
}

export function resolveDisplayAudiotype(
  audiotype: number | null | undefined,
  queueAuthority?: string | null,
): number | undefined {
  if (audiotype == null) {
    return undefined;
  }
  if (audiotype === AudioType.Spotify && queueAuthority !== 'spotify') {
    return AudioType.Playlist;
  }
  return audiotype;
}

export function buildInitialState(zone: ZoneConfig): ZoneState {
  const defaultVol = getZoneDefaultVolume(zone);
  return {
    id: zone.id,
    name: zone.name,
    title: '',
    artist: '',
    album: '',
    coverurl: '',
    audiopath: '',
    duration: 0,
    eq: getZoneEqualizerBands(zone),
    time: 0,
    qindex: 0,
    queueAuthority: 'local',
    plshuffle: 0,
    plrepeat: 0,
    volume: defaultVol,
    mode: 'stop',
    audiotype: 0,
    sourceName: zone.sourceMac,
    station: '',
    type: 3,
    clientState: 'on',
    power: 'on',
  };
}
