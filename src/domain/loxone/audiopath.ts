/**
 * Decodes a raw Loxone audiopath (including any appended routing hints) into a
 * usable URI for downstream outputs.
 *
 * The MiniServer often appends suffixes such as `/parentpath/...`, `/noshuffle`
 * or query markers to the original payload. Those hints are stripped before the
 * base64 payload (if present) is decoded. When the payload is not base64 the
 * cleaned string is returned unchanged so higher layers can still inspect it.
 */
export function decodeAudiopath(path: string): string {
  if (!path) {
    return '';
  }

  const cleaned = stripRoutingSuffix(path);

  const parts = cleaned.split(':');
  const last = parts[parts.length - 1];
  if (last?.startsWith('b64_')) {
    const payload = last.slice('b64_'.length);
    try {
      return Buffer.from(payload, 'base64').toString('utf8');
    } catch {
      return cleaned;
    }
  }

  // Preserve raw Music Assistant URIs intact (they embed provider/user info).
  if (/musicassistant/i.test(cleaned)) {
    return cleaned;
  }

  return cleaned;
}

/**
 * Wraps an external provider URI in a Loxone-compatible audiopath.
 * Defaults to the MusicAssistant bridge prefix so the queue accepts it.
 */
export function encodeAudiopath(
  originalUri: string,
  itemType = 'track',
  providerPrefix = 'spotify@nouser',
  useBase64 = true,
): string {
  if (!originalUri) return '';
  if (useBase64) {
    const encoded = Buffer.from(originalUri, 'utf-8').toString('base64');
    return `${providerPrefix}:${itemType}:b64_${encoded}`;
  }
  return `${providerPrefix}:${itemType}:${originalUri}`;
}

function stripRoutingSuffix(path: string): string {
  let working = path;

  working = working
    .replace(/\/parentid\/.*$/i, '')
    .replace(/\/parentpath\/.*$/i, '')
    .replace(/\/noshuffle.*$/i, '')
    .replace(/\/\?q&ZW5mb3JjZVVzZXI9dHJ1ZQ.*$/i, '')
    .replace(/\/\?q&[A-Za-z0-9+/=]+$/i, '')
    .replace(/\/+$/, '');

  return working;
}

/**
 * Lightweight provider detection for Loxone audiopaths.
 */
export function detectServiceFromAudiopath(
  p: string,
): 'spotify' | 'radio' | 'library' | 'musicassistant' | 'applemusic' | 'deezer' | 'tidal' {
  const raw = (p || '').toLowerCase();
  if (
    raw.includes('musicassistant') ||
    raw.startsWith('musicassistant://') ||
    raw.startsWith('musicassistant@')
  ) {
    return 'musicassistant';
  }
  if (raw.includes('applemusic')) {
    return 'applemusic';
  }
  if (raw.includes('deezer')) {
    return 'deezer';
  }
  if (raw.includes('tidal')) {
    return 'tidal';
  }
  if (raw.startsWith('tunein:') || raw.startsWith('radio:') || raw.includes('tunein')) {
    return 'radio';
  }
  const decoded = decodeAudiopath(p);
  const lower = decoded.toLowerCase();
  if (lower.includes('musicassistant') || lower.startsWith('musicassistant')) {
    return 'musicassistant';
  }
  if (lower.includes('applemusic')) {
    return 'applemusic';
  }
  if (lower.includes('deezer')) {
    return 'deezer';
  }
  if (lower.includes('tidal')) {
    return 'tidal';
  }
  if (lower.startsWith('tunein:') || lower.startsWith('radio:') || /(tunein|radio)/.test(lower)) {
    return 'radio';
  }
  if (lower.startsWith('spotify:') || lower.startsWith('spotify@')) {
    return 'spotify';
  }
  return 'library';
}

/**
 * Rough item-type detection from an audiopath for Loxone semantics.
 */
export function detectLoxoneItemType(
  audiopath: string,
  service?: string,
): 'track' | 'album' | 'playlist' | 'artist' | 'tunein' | string {
  const lower = (audiopath || '').toLowerCase();
  const svc = service ?? detectServiceFromAudiopath(audiopath);
  if (/(tunein|radio)/.test(lower)) return 'tunein';
  if (lower.includes('playlist')) return 'playlist';
  if (lower.includes('album')) return `${svc}_album`;
  if (lower.includes('artist')) return `${svc}_artist`;
  if (lower.includes('track')) return `${svc}_track`;
  return 'track';
}

/**
 * Small heuristic to infer audiotype from a URI.
 *  - 5: Spotify (and Music Assistant bridge)
 *  - 4: Radio
 *  - 1: File/stream
 *  - 0: Unknown / other
 */
export function inferAudiotype(uri: string): number {
  const lower = uri.toLowerCase();
  if (
    lower.includes('musicassistant') ||
    lower.includes('applemusic') ||
    lower.includes('deezer') ||
    lower.includes('tidal') ||
    lower.startsWith('spotify:') ||
    lower.startsWith('spotify@')
  ) {
    return 5;
  }
  if (lower.startsWith('radio://') || lower.includes('tunein')) {
    return 4;
  }
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('library:') ||
    lower.startsWith('library://')
  ) {
    return 1;
  }
  return 0;
}
