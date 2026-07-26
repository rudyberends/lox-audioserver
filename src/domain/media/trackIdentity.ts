/**
 * The base64 wrapper around a track identity.
 *
 * A track is identified by a URI — `library://…`, `applemusic:track:…`. Some of
 * those carry characters that do not survive the paths they travel, so the last
 * segment may be wrapped: `applemusic:library-album:b64_<payload>`. This unwraps
 * it, and leaves anything unwrapped alone.
 *
 * Deliberately separate from the Loxone decoder: that one first strips the routing
 * hints the Miniserver appends to a payload (`/parentpath/…`, `/noshuffle`), which
 * is a fact about that client. A DLNA controller or a Subsonic client never sends
 * those, so it should not need a function that knows about them.
 */

const B64_PREFIX = 'b64_';

export function decodeTrackUri(uri: string): string {
  if (!uri) {
    return '';
  }
  const parts = uri.split(':');
  const last = parts[parts.length - 1];
  if (last?.startsWith(B64_PREFIX)) {
    try {
      return Buffer.from(last.slice(B64_PREFIX.length), 'base64').toString('utf8');
    } catch {
      return uri;
    }
  }
  return uri;
}
