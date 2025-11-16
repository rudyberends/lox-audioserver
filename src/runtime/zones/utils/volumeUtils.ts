/**
 * -----------------------------------------------------------------------------
 * convertToAbsoluteVolume
 * -----------------------------------------------------------------------------
 * Normalizes any volume input (absolute or relative) into a final absolute
 * volume value between 0 and 100.
 *
 * Supported input formats:
 *
 *   1. Absolute numeric value:
 *        40          → 40
 *        "40"        → 40
 *
 *   2. Relative delta:
 *        "+3"        → currentVolume + 3
 *        "-5"        → currentVolume - 5
 *        { delta: 3} → currentVolume + 3
 *
 *   3. Explicit absolute object:
 *        { absolute: 30 } → 30
 *
 * This function guarantees that the returned value is clamped to the
 * allowed range [0, 100]. It centralizes all volume parsing so the rest
 * of the system can operate purely on absolute volume levels.
 * -----------------------------------------------------------------------------
 */
export function convertToAbsoluteVolume(raw: unknown, currentVolume: number): number {
  // Explicit absolute: { absolute: number }
  if (raw && typeof raw === 'object' && 'absolute' in (raw as any)) {
    return clamp(Number((raw as any).absolute));
  }

  const str = String(raw ?? '').trim();

  // Relative: "+3" / "-2"
  if (/^[+-]\d+$/.test(str)) {
    return clamp(currentVolume + Number(str));
  }

  // Plain absolute: "40"
  if (/^\d+$/.test(str)) {
    return clamp(Number(str));
  }

  // Relative as object: { delta: number }
  const delta = Number((raw as any)?.delta ?? 0);
  return clamp(currentVolume + delta);
}

function clamp(v: number): number {
  return Math.max(0, Math.min(100, v));
}