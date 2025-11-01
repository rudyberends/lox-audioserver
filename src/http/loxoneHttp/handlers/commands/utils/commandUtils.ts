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

/**
 * Safely decodes a single URL segment, returning the original string on failure.
 *
 * @param value - The encoded segment (may be undefined or malformed)
 * @returns The decoded string, or the original value if decoding fails
 */
export function decodeSegment(value: string | undefined): string {
  if (!value) {
    return '';
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Safely decodes a Base64-encoded URL segment back into a UTF-8 string.
 * Accepts URL-safe Base64 (`-`, `_`) and auto-pads to valid 4-byte alignment.
 */
export function decodeBase64Segment(segment: string): string {
  const restored = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (restored.length % 4 || 4)) % 4;
  const padded = restored.padEnd(restored.length + padding, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

/**
 * Attempts to parse a JSON string and returns either the object or `null`.
 * @typeParam T - Expected JSON structure.
 */
export function safeJsonParse<T = unknown>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}