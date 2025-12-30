export const DEFAULT_MIN_SEARCH_LIMIT = 5;
export const DEFAULT_MAX_SEARCH_LIMIT = 20;
export const DEFAULT_FALLBACK_SEARCH_LIMIT = 10;

export type SearchLimits = Record<string, number>;

export interface SearchLimitOptions {
  min?: number;
  max?: number;
  fallback?: number;
}

/**
 * Parse a Loxone-style filter string ("track#5,album#3") into per-type limits,
 * and compute a clamped max limit used for provider queries.
 */
export function parseSearchLimits(
  filterPart: string | undefined,
  options: SearchLimitOptions = {},
): { limits: SearchLimits; maxLimit: number } {
  const minLimit = options.min ?? DEFAULT_MIN_SEARCH_LIMIT;
  const maxLimitCap = options.max ?? DEFAULT_MAX_SEARCH_LIMIT;
  const fallbackLimit = options.fallback ?? DEFAULT_FALLBACK_SEARCH_LIMIT;

  const limits: SearchLimits = {};
  for (const entry of (filterPart ?? '').split(',')) {
    if (!entry) continue;
    const [type, rawLimit] = entry.split('#');
    if (!type) continue;
    const value = Number(rawLimit);
    const safeValue =
      Number.isFinite(value) && value > 0 ? value : minLimit;
    limits[type.trim().toLowerCase()] = safeValue;
  }

  const explicit = Object.values(limits);
  const maxLimit =
    explicit.length > 0
      ? Math.min(Math.max(...explicit, minLimit), maxLimitCap)
      : fallbackLimit;

  return { limits, maxLimit };
}
