/**
 * Entity-id codec for the Subsonic API.
 *
 * Subsonic ids are opaque strings a client round-trips verbatim — and, unlike
 * DLNA object ids, clients **persist** them (favourites, offline downloads,
 * playlists), so they must stay stable across restarts and rescans. That rules
 * out the library's SQLite rowids: `rescan()` does a full `DELETE FROM tracks`
 * and re-inserts, so every `tracks.id` changes. We therefore key on the content
 * layer's own stable identities instead:
 *
 *   - containers → `<tag>.<b64url(serviceKey)>.<b64url(folderId)>`, where the
 *     folderId is the native id we hand straight back to the content layer,
 *   - songs → `t.<b64url(audiopath)>`, so browse→play needs no second lookup.
 *
 * The separator is `.` because it is outside the base64url alphabet
 * (`A-Za-z0-9-_`), which `-` and `_` are not.
 *
 * Tags carry the entity *type* rather than just the shape, because Subsonic
 * models the same underlying folder as a directory, an artist or an album
 * depending on which endpoint returned it, and clients feed an id back to the
 * endpoint that matches its type.
 */

const SEP = '.';

const TAGS = {
  dir: 'd',
  artist: 'ar',
  album: 'al',
  playlist: 'pl',
  song: 't',
} as const;

export type SubsonicContainerKind = 'dir' | 'artist' | 'album' | 'playlist';

export type SubsonicRef =
  | { kind: SubsonicContainerKind; service: string; folderId: string }
  | { kind: 'song'; audiopath: string };

function b64urlEncode(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(value: string): string {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

export function encodeContainerId(
  kind: SubsonicContainerKind,
  service: string,
  folderId: string,
): string {
  return `${TAGS[kind]}${SEP}${b64urlEncode(service)}${SEP}${b64urlEncode(folderId || 'root')}`;
}

export function encodeSongId(audiopath: string): string {
  return `${TAGS.song}${SEP}${b64urlEncode(audiopath)}`;
}

/**
 * Decode any entity id back into a typed ref. Returns null for structurally
 * invalid ids so the endpoint can answer a clean Subsonic fault (code 70)
 * instead of throwing.
 *
 * Note that base64 decoding in Node never throws on malformed input, so a
 * garbage payload yields a garbage-but-harmless folderId/audiopath that the
 * content layer simply fails to resolve.
 */
export function decodeEntityId(id: string): SubsonicRef | null {
  const raw = (id || '').trim();
  if (!raw) {
    return null;
  }
  const parts = raw.split(SEP);
  const tag = parts[0];

  if (tag === TAGS.song) {
    if (parts.length !== 2 || !parts[1]) {
      return null;
    }
    const audiopath = b64urlDecode(parts[1]);
    return audiopath ? { kind: 'song', audiopath } : null;
  }

  const kind = (Object.keys(TAGS) as Array<keyof typeof TAGS>).find(
    (key) => key !== 'song' && TAGS[key] === tag,
  );
  if (!kind || parts.length !== 3) {
    return null;
  }
  const service = b64urlDecode(parts[1] ?? '');
  const folderId = b64urlDecode(parts[2] ?? '');
  if (!service || !folderId) {
    return null;
  }
  return { kind: kind as SubsonicContainerKind, service, folderId };
}

/** Re-tag a container id as a different entity type, keeping service+folder. */
export function retagContainerId(ref: SubsonicRef, kind: SubsonicContainerKind): string | null {
  if (ref.kind === 'song') {
    return null;
  }
  return encodeContainerId(kind, ref.service, ref.folderId);
}

/**
 * Stable numeric id for a music folder.
 *
 * `getMusicFolders` is specified to return integer ids and clients pass them
 * back as `musicFolderId`, so a service key cannot be used directly. FNV-1a
 * folded into a positive int31 gives an id that depends only on the key — stable
 * across restarts and independent of config ordering (unlike an array index).
 */
export function musicFolderId(serviceKey: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < serviceKey.length; i += 1) {
    hash ^= serviceKey.charCodeAt(i);
    // FNV prime, kept in 32-bit range via Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  // Drop the sign bit: ids must be non-negative, and 0 is reserved as "unset".
  return (hash & 0x7fffffff) || 1;
}
