/**
 * Pure HLS/M3U8 parsing and rewriting helpers for the Apple Music stream service.
 *
 * These functions hold no state and never touch the network; they only parse or transform
 * playlist text and URLs. Keeping them here makes them unit-testable in isolation and keeps
 * the stream service focused on orchestration, DRM and the local proxy.
 */

export const WIDEVINE_KEYFORMAT_UUID = 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';

export type M3u8KeyInfo = { uri: string; line: string; format?: string };

/** Read a single attribute value from an M3U8 tag line (handles quoted/escaped values). */
export function readM3u8Attribute(line: string, name: string): string | undefined {
  const pattern = new RegExp(`${name}=("(?:[^"\\\\]|\\\\.)*"|[^,]*)`, 'i');
  const match = line.match(pattern);
  if (!match?.[1]) return undefined;
  let value = match[1].trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
  }
  value = value.replace(/\\(.)/g, '$1');
  return value;
}

/** True when an EXT-X-KEY KEYFORMAT identifies Widevine. */
export function isWidevineKeyformat(format?: string): boolean {
  if (!format) return false;
  const normalized = format.toLowerCase();
  return normalized.includes('widevine') || normalized.includes(WIDEVINE_KEYFORMAT_UUID);
}

/** Pick the most relevant EXT-X-KEY entry (Widevine first, then base64, then first available). */
export function extractKeyInfo(playlist: string): M3u8KeyInfo | null {
  const lines = playlist.split(/\r?\n/);
  const entries: M3u8KeyInfo[] = [];
  for (const line of lines) {
    if (!line.startsWith('#EXT-X-KEY')) continue;
    const uri = readM3u8Attribute(line, 'URI');
    if (!uri) continue;
    const format = readM3u8Attribute(line, 'KEYFORMAT');
    entries.push({ uri, line, format });
  }
  if (!entries.length) return null;
  const widevine = entries.find((entry) => isWidevineKeyformat(entry.format));
  if (widevine) return widevine;
  const base64 = entries.find((entry) => entry.uri.toLowerCase().includes('base64,'));
  return base64 ?? entries[0] ?? null;
}

/** Find a data:...;base64,... key URI anywhere in the playlist (fallback search). */
export function findPsshKeyUri(playlist: string): string | null {
  const match = playlist.match(/URI=(?:"|\\")?(data:[^,]+;base64,[A-Za-z0-9+/=]+)(?:"|\\")?/i);
  return match?.[1] ?? null;
}

/** Resolve the first variant playlist URL from a master playlist, if present. */
export function findVariantPlaylistUrl(playlist: string, baseUrl: string): string | null {
  if (!/#EXT-X-STREAM-INF/i.test(playlist)) return null;
  const lines = playlist.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.startsWith('#EXT-X-STREAM-INF')) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      const uri = lines[j]?.trim();
      if (!uri || uri.startsWith('#')) continue;
      try {
        return new URL(uri, baseUrl).toString();
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Return the first media segment URL (absolute) from a media playlist. */
export function extractFirstSegmentUrl(playlist: string, baseUrl: string): string | null {
  const lines = playlist.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    try {
      return new URL(trimmed, baseUrl).toString();
    } catch {
      return null;
    }
  }
  return null;
}

/** Parse the EXT-X-MAP init URL and all media segment URLs from a media playlist. */
export function parseSegmentUrls(
  playlist: string,
  baseUrl: string,
): { initUrl?: string; segments: string[] } {
  const lines = playlist.split(/\r?\n/);
  let initUrl: string | undefined;
  const segments: string[] = [];
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP')) {
      const uri = readM3u8Attribute(line, 'URI');
      if (uri) {
        try {
          initUrl = new URL(uri, baseUrl).toString();
        } catch {
          initUrl = undefined;
        }
      }
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    try {
      segments.push(new URL(line.trim(), baseUrl).toString());
    } catch {
      // ignore invalid
    }
  }
  return { initUrl, segments };
}

/** Remove an attribute (and a dangling separator) from an M3U8 tag line. */
export function stripM3u8Attribute(line: string, name: string): string {
  const pattern = new RegExp(`(?:,)?${name}=("(?:[^"\\\\]|\\\\.)*"|[^,]*)`, 'ig');
  let next = line.replace(pattern, '');
  next = next.replace(/,(\s*)$/, '');
  next = next.replace(/:,+/, ':');
  next = next.replace(/,,+/g, ',');
  return next;
}

/** Replace (or append) a quoted attribute on an M3U8 tag line. */
export function replaceM3u8Attribute(line: string, name: string, value: string): string {
  const pattern = new RegExp(`${name}=("(?:[^"\\\\]|\\\\.)*"|[^,]*)`, 'i');
  if (pattern.test(line)) {
    return line.replace(pattern, `${name}="${value}"`);
  }
  const suffix = line.includes(':') ? ',' : ':';
  return `${line}${suffix}${name}="${value}"`;
}

/** True when a URL points at an HLS playlist. */
export function isHlsUrl(streamUrl: string): boolean {
  return /\.m3u8($|\?)/i.test(streamUrl);
}
