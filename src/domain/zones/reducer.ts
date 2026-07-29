import type { ZoneState } from '@/domain/zones/zoneState';

export function applyZonePatch(
  state: ZoneState,
  patch: Partial<ZoneState>,
  _opts?: { force?: boolean },
): ZoneState {
  return { ...state, ...patch };
}
