/**
 * Splits a Loxone command into parts without dropping empty segments.
 */
export function splitCommand(command: string): string[] {
  return (command ?? '').split('/');
}

/**
 * Parses a numeric segment or returns a default value.
 */
export function parseNumberPart(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Decodes a URL segment safely.
 */
export function decodeSegment(segment: string | undefined): string {
  if (!segment) {
    return '';
  }
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Extracts a playback payload from the remaining command segments by removing
 * Loxone-specific suffixes (like `/noshuffle` or query blobs).
 */
export function extractPayload(segments: readonly string[]): string {
  const raw = segments.join('/');
  const cleaned = stripNoise(raw);
  return decodeSegment(cleaned);
}

function stripNoise(value: string): string {
  return (value ?? '')
    .replace(/\/\?q&ZW5mb3JjZVVzZXI9dHJ1ZQ.*$/i, '')
    .replace(/\/\?q&[A-Za-z0-9+/=]+$/i, '')
    .replace(/\/noshuffle.*$/i, '')
    .replace(/\/+$/i, '');
}
