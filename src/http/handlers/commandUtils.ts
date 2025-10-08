/**
 * Split an incoming command URL into parts without dropping empty segments.
 * Keeping empty values preserves legacy indexing logic used by the handler routes.
 */
export function splitUrl(url: string): string[] {
  return (url || '').split('/');
}

/**
 * Parse a potentially undefined numeric segment, falling back to the provided default.
 */
export function parseNumberPart(value: string | undefined, defaultValue: number): number {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Convenience helper for commands that rely on offset/limit pagination parameters.
 */
export function parsePaging(parts: string[], startIndex: number, defaultLimit: number): {
  offset: number;
  limit: number;
} {
  const offset = parseNumberPart(parts[startIndex], 0);
  const limit = parseNumberPart(parts[startIndex + 1], defaultLimit);
  return { offset, limit };
}
