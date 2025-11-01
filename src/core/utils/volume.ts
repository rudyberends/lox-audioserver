export function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function computeRelativeVolume(current: number, delta: number): number {
  return clampPercent((Number(current) || 0) + (Number(delta) || 0));
}

