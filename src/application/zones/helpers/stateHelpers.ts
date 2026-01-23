import type { ZoneConfig } from '@/domain/config/types';
import type { QueueState } from '@/application/zones/zoneManager';
import type { LoxoneZoneState } from '@/domain/loxone/types';

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
  if (/^[A-Za-z0-9]{16,}$/i.test(title.trim())) {
    return fallback;
  }
  return title;
}

export function isUriLike(value: string | undefined): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return lower.startsWith('spotify:') || lower.startsWith('spotify@') || /^[A-Za-z0-9]{16,}$/.test(value.trim());
}

export function buildInitialState(zone: ZoneConfig): LoxoneZoneState {
  const defaultVol = getZoneDefaultVolume(zone);
  return {
    playerid: zone.id,
    name: zone.name,
    title: '',
    artist: '',
    album: '',
    coverurl: '',
    audiopath: '',
    duration: 0,
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
    parent: null,
    type: 3,
    clientState: 'on',
    power: 'on',
  };
}
