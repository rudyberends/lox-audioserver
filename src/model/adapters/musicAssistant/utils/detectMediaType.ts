/**
 * Extracts the media type segment from a provider URI.
 *
 * Examples:
 *   "library://album/123"        → "album"
 *   "apple_music://track/14365"  → "track"
 *   "deezer://artist/77"         → "artist"
 *   "spotify:playlist:abc"       → "playlist"
 *   "radio://station/12"         → "station"
 */
export function detectMediaType(uri?: string | null): string {
  if (!uri) {
    return 'unknown';
  }
  const normalized = uri.trim().toLowerCase();

  // Match pattern after "://" or ":" before next "/"
  const match = normalized.match(/:\/\/([^/]+)|:(album|artist|track|playlist|radio)/);
  if (match) {
    return match[1] ?? match[2] ?? 'unknown';
  }

  return 'unknown';
}