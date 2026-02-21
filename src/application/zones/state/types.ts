import type { ZoneConfig } from '@/domain/config/types';

export type ZoneStateControllerId = 'internal' | string;

export function resolveZoneStateControllerId(zone: ZoneConfig): ZoneStateControllerId {
  const raw = typeof zone.state?.controller === 'string' ? zone.state.controller.trim().toLowerCase() : '';
  if (!raw) return 'internal';
  const normalized = raw.replace(/[\s_-]+/g, '');
  if (normalized === 'beolink') return 'beolink';
  if (normalized === 'sonos') return 'sonos';
  if (normalized === 'internal') return 'internal';
  return raw;
}
