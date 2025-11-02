// src/core/loxone/mediaMapping.ts

/**
 * Detects the Loxone media type based on the `audiopath` string.
 * Maps URIs like `library://album/...` or `spotify:track:...`
 * to a normalized Loxone item type.
 */
export function detectLoxoneItemType(audiopath: string): string {
  const path = audiopath.toLowerCase();

  if (path.includes('tunein') || path.includes('radio')) {
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

/**
 * Mapping from normalized Loxone item types to compatible path prefixes.
 */
const prefixMap: Record<string, string> = {
  tunein: 'tunein:station:s',
  spotify_playlist: 'spotify:playlist:',
  playlist: 'playlist:',
  spotify_artist: 'spotify:artist:',
  spotify_album: 'spotify:album:',
  spotify_track: 'spotify:track:',
};

/**
 * Returns the Loxone path prefix for a given item type.
 * Inverse of detectLoxoneItemType().
 */
export function getLoxonePrefixForType(type: string, fallback = 'spotify_track'): string {
  return prefixMap[type.toLowerCase()] ?? prefixMap[fallback];
}