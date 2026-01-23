import type { LoxoneZoneState } from '@/domain/loxone/types';

export function applyZonePatch(
  state: LoxoneZoneState,
  patch: Partial<LoxoneZoneState>,
  _opts?: { force?: boolean },
): LoxoneZoneState {
  return { ...state, ...patch };
}
