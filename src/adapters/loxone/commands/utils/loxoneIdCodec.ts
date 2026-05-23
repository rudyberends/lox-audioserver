/**
 * Loxone-canonical id encoding (matches the legacy music-server reference).
 *
 * Encoded ids are base64url(JSON.stringify([data, offset])) where:
 *  - data: the raw id (string or number)
 *  - offset: a base constant indicating the resource type (e.g. BASE_PLAYLIST + slot)
 *
 * The Loxone client passes the encoded form back in subsequent URLs (update,
 * rename, delete, play). Decoding gives back the raw id and base.
 */

export const BASE_DELTA = 1_000_000;
export const BASE_SERVICE = 1 * BASE_DELTA;
export const BASE_FAVORITE_GLOBAL = 2 * BASE_DELTA;
export const BASE_PLAYLIST = 3 * BASE_DELTA;
export const BASE_LIBRARY = 4 * BASE_DELTA;
export const BASE_INPUT = 5 * BASE_DELTA;
export const BASE_FAVORITE_ZONE = 6 * BASE_DELTA;

const FORWARD_TABLE: Record<string, string> = { '+': '-', '/': '_', '=': '' };
const REVERSE_TABLE: Record<string, string> = { '-': '+', _: '/' };

export function encodeLoxoneId(data: string | number, offset: number): string {
  return Buffer.from(JSON.stringify([data, offset]))
    .toString('base64')
    .replace(/[+/=]/g, (ch) => FORWARD_TABLE[ch] ?? ch);
}

export function decodeLoxoneId(raw: string): { data: string | number; offset: number } | null {
  if (!raw) return null;
  try {
    const normalized = raw.replace(/[-_]/g, (ch) => REVERSE_TABLE[ch] ?? ch);
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as [string | number, number];
    if (!Array.isArray(parsed) || parsed.length < 2) return null;
    return { data: parsed[0], offset: parsed[1] };
  } catch {
    return null;
  }
}
