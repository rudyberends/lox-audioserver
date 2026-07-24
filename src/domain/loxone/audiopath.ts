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
 * Normalises a provider-scoped Loxone audiopath to its provider-less canonical
 * form, mirroring how room favourites are stored. Strips a leading
 * `spotify@<account>:` bridge prefix down to `spotify:` and collapses the Apple
 * `:library-track:` alias to `:track:`.
 */
export function normalizeProviderAudiopath(audiopath: string): string {
  if (!audiopath) {
    return audiopath;
  }
  if (audiopath.startsWith('spotify@')) {
    const tail = audiopath.replace(/^spotify@[^:]+:/i, 'spotify:');
    return tail.replace(/:library-track:/i, ':track:');
  }
  return audiopath.replace(/:library-track:/i, ':track:');
}

/**
 * The set of keys an audiopath may be stored under / looked up by in the
 * harvested-metadata cache. Both the harvest (store) and resolve (lookup) sides
 * run an audiopath through this, so a listing item indexed under its raw
 * provider path is still found when a caller later asks with the decoded or
 * provider-stripped variant (e.g. a normalised room-favourite path).
 */
export function metadataKeyVariants(audiopath: string): string[] {
  const raw = (audiopath || '').trim();
  if (!raw) {
    return [];
  }
  const variants: string[] = [];
  const add = (value: string | undefined | null): void => {
    const trimmed = (value || '').trim();
    if (trimmed && !variants.includes(trimmed)) {
      variants.push(trimmed);
    }
  };
  add(raw);
  const decoded = decodeAudiopath(raw);
  add(decoded);
  add(normalizeProviderAudiopath(raw));
  add(normalizeProviderAudiopath(decoded));
  return variants;
}

/**
 * Lightweight provider detection for Loxone audiopaths.
 */
export function detectServiceFromAudiopath(
  p: string,
): 'spotify' | 'radio' | 'library' | 'musicassistant' | 'applemusic' | 'deezer' | 'tidal' | 'ytmusic' | 'soundcloud' {
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
  if (raw.includes('soundcloud')) {
    return 'soundcloud';
  }
  if (raw.includes('ytmusic') || raw.includes('youtube music') || raw.includes('bridge-ytmusic')) {
    return 'ytmusic';
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
  if (lower.includes('soundcloud')) {
    return 'soundcloud';
  }
  if (lower.includes('ytmusic') || lower.includes('youtube music') || lower.includes('bridge-ytmusic')) {
    return 'ytmusic';
  }
  if (lower.includes('radioparadise')) {
    return 'radio';
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
 * Small heuristic to infer audiotype from a URI. Returns values from the
 * Loxone `AudioType` enum (File=0, Radio=1, LineIn=3, Spotify=5).
 */
export function inferAudiotype(uri: string): number {
  const lower = uri.toLowerCase();
  if (
    lower.includes('musicassistant') ||
    lower.includes('applemusic') ||
    lower.includes('deezer') ||
    lower.includes('tidal') ||
    lower.includes('soundcloud') ||
    lower.startsWith('spotify:') ||
    lower.startsWith('spotify@')
  ) {
    return 5;
  }
  if (
    lower.startsWith('radio://') ||
    lower.startsWith('tunein:') ||
    lower.startsWith('radioparadise:') ||
    lower.includes('tunein')
  ) {
    return 1;
  }
  if (lower.startsWith('linein:') || lower.startsWith('linein://')) {
    return 3;
  }
  if (
    lower.startsWith('library:') ||
    lower.startsWith('library://') ||
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('file:')
  ) {
    return 0;
  }
  return 0;
}
