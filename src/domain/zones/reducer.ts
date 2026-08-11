import type { ZoneState } from '@/domain/zones/zoneState';

export function applyZonePatch(
  state: ZoneState,
  patch: Partial<ZoneState>,
  _opts?: { force?: boolean },
): ZoneState {
  const next = { ...state, ...patch };
  /**
   * A zone that is audible is not muted, whoever made it audible. Every path that
   * moves the volume ends up here — a command, a device reporting its own knob, an
   * alert restoring a level — and none of them should have to know that mute exists.
   * A patch that states `muted` outright wins, so muting can set the volume to zero
   * and flip the flag in one go.
   */
  if (patch.volume !== undefined && patch.muted === undefined && patch.volume > 0) {
    next.muted = false;
  }
  return next;
}
