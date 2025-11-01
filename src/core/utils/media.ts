export function parseShuffle(param: unknown): boolean {
  const flag = String(param ?? '').toLowerCase();
  return ['1', 'true', 'on', 'enable', 'enabled', 'yes'].includes(flag);
}

export type RepeatMode3 = 'off' | 'one' | 'all';

export function parseRepeat(param: unknown): RepeatMode3 {
  const mode = String(param ?? 'off').toLowerCase();
  if (mode === 'one' || mode === 'track' || mode === '1') return 'one';
  if (mode === 'all' || mode === 'queue' || mode === '2') return 'all';
  return 'off';
}

export function safeString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (!v) return '';
  if (Array.isArray(v)) return v.map((x) => safeString(x)).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.name === 'string') return o.name;
    if (typeof o.title === 'string') return o.title;
  }
  return '';
}

export function safeNumber(v: unknown, opts?: { min?: number; max?: number; round?: boolean }): number {
  let n = Number(v ?? 0);
  if (!Number.isFinite(n)) n = 0;
  if (opts?.round) n = Math.round(n);
  if (typeof opts?.min === 'number') n = Math.max(opts.min, n);
  if (typeof opts?.max === 'number') n = Math.min(opts.max, n);
  return n;
}

export function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}
