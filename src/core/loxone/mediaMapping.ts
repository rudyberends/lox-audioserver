/**
 * -----------------------------------------------------------------------------
 * Loxone Media Mapping (strict and type-safe)
 * -----------------------------------------------------------------------------
 * Converts between provider URIs (e.g. "apple_music://track/1436541467")
 * and normalized Loxone item types ("spotify_track", "tunein", etc.).
 * Provides deterministic, provider-agnostic mapping in both directions.
 * -----------------------------------------------------------------------------
 */

export type LoxoneItemType =
  | 'tunein'
  | 'spotify_playlist'
  | 'playlist'
  | 'spotify_artist'
  | 'spotify_album'
  | 'spotify_track'
  | 'unknown';

const prefixMap = {
  tunein: 'tunein:station:s',
  spotify_playlist: 'spotify:playlist:',
  playlist: 'playlist:',
  spotify_artist: 'spotify:artist:',
  spotify_album: 'spotify:album:',
  spotify_track: 'spotify:track:',
} as const;

type KnownLoxoneItemType = Exclude<LoxoneItemType, 'unknown'>;

/** Detects the Loxone item type from an audiopath. */
export function detectLoxoneItemType(audiopath: string): LoxoneItemType {
  const path = audiopath.toLowerCase();
  if (/(tunein|radio)/.test(path)) {
    return 'tunein';
  }
  if (path.includes('playlist')) {
    return 'spotify_playlist';
  }
  if (path.includes('album')) {
    return 'spotify_album';
  }
  if (path.includes('artist')) {
    return 'spotify_artist';
  }
  if (path.includes('track')) {
    return 'spotify_track';
  }
  return 'unknown';
}

/** Returns the canonical Loxone prefix for a given type. */
export function getLoxonePrefixForType(
  type: LoxoneItemType,
  fallback: KnownLoxoneItemType = 'spotify_track',
): string {
  const map: Record<KnownLoxoneItemType, string> = prefixMap;
  return map[(type === 'unknown' ? fallback : type) as KnownLoxoneItemType];
}

/**
 * -----------------------------------------------------------------------------
 * Generic: Provider → Loxone URI encoding (provider-agnostic)
 * -----------------------------------------------------------------------------
 * Wraps any external provider URI in a Loxone-compatible format.
 * Example:
 *   buildAudiopathFromUri("apple_music://track/1436541467", "track")
 *   → "spotify@musicassistant:track:YXBwbGVfbXVzaWM6Ly90cmFjay8xNDM2NTQxNDY3"
 * -----------------------------------------------------------------------------
 */
export function buildAudiopath(originalUri: string, itemType: string): string {
  if (!originalUri) {
    return '';
  }

  // Radio stays native
  if (itemType === 'radio') {
    return `tunein:station:${Buffer.from(originalUri).toString('base64')}`;
  }

  const encoded = Buffer.from(originalUri).toString('base64');
  return `spotify@nouser:${itemType}:${encoded}`;
}

/** Decodes a base64-wrapped Loxone audiopath back to its original provider URI. */
export function decodeAudiopath(audiopath: string): string {
  if (!audiopath) {
    return '';
  }
  if (audiopath.startsWith('tunein:')) {
    return audiopath;
  }

  const encoded = audiopath.split(':').pop();
  if (!encoded) {
    return audiopath;
  }

  try {
    return Buffer.from(encoded, 'base64').toString('utf8') || audiopath;
  } catch {
    return audiopath;
  }
}