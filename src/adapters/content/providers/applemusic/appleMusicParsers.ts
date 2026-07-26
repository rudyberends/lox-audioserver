/**
 * Pure mapping helpers that turn Apple Music API objects into Loxone ContentFolderItem shapes.
 *
 * These are the TypeScript counterpart of Music Assistant's parsers.py: no instance state, no
 * network — just translation. Each mapper takes the owning provider id so the generated
 * audiopaths/ids stay scoped to that provider instance.
 */

import type { ContentFolderItem } from '@/ports/ContentTypes';
import { resizeCoverUrl, COVER_ART_NOW_PLAYING_SIZE } from '@/shared/coverArt';

export enum FileType {
  Folder = 1,
  File = 2,
  PlaylistBrowsable = 7,
}

/** Build a provider-scoped audiopath/id, e.g. `spotify@am1:track:b64_...`. */
export function makeUri(providerId: string, type: string, id: string): string {
  return `${providerId}:${type}:${id}`;
}

/** Encode an Apple id into a transport-safe, prefixed token. */
export function encodeId(raw: string): string {
  if (!raw) {
    return '';
  }
  if (raw.startsWith('b64_')) {
    return raw;
  }
  return `b64_${Buffer.from(raw, 'utf-8').toString('base64')}`;
}

/** Decode a token produced by {@link encodeId} back into the raw Apple id. */
export function decodeId(raw: string): string {
  if (!raw) {
    return '';
  }
  if (raw.startsWith('b64_')) {
    try {
      return Buffer.from(raw.slice(4), 'base64').toString('utf-8');
    } catch {
      return raw.slice(4);
    }
  }
  return raw;
}

/** Resolve a usable cover URL from an Apple attributes object (artwork template, url100, editorial). */
export function extractArtwork(attrs: any, size: number = COVER_ART_NOW_PLAYING_SIZE): string {
  const fromTemplate = (tmpl?: string): string | null => {
    if (typeof tmpl === 'string' && tmpl.includes('{w}') && tmpl.includes('{h}')) {
      return tmpl.replace('{w}', String(size)).replace('{h}', String(size));
    }
    if (typeof tmpl === 'string' && tmpl.startsWith('http')) {
      return tmpl;
    }
    return null;
  };

  const direct = fromTemplate(attrs?.artwork?.url);
  if (direct) {
    return direct;
  }

  if (typeof attrs?.artworkUrl100 === 'string') {
    return resizeCoverUrl(attrs.artworkUrl100, size);
  }

  const editorial = attrs?.editorialArtwork;
  if (editorial && typeof editorial === 'object') {
    for (const key of Object.keys(editorial)) {
      const entry = editorial[key];
      const candidate = fromTemplate(entry?.url);
      if (candidate) {
        return candidate;
      }
    }
  }

  return '';
}

export function mapTrack(providerId: string, track: any): ContentFolderItem {
  const attrs = track?.attributes ?? track;
  const id = encodeId(track?.id ?? attrs?.id ?? '');
  const name = attrs?.name ?? 'Track';
  const artist = attrs?.artistName ?? '';
  const album = attrs?.albumName ?? '';
  const cover = extractArtwork(attrs);
  return {
    id: makeUri(providerId, 'track', id),
    audiopath: makeUri(providerId, 'track', id),
    name,
    title: name,
    artist,
    album,
    coverurl: cover,
    thumbnail: cover,
    type: FileType.File,
    tag: 'track',
    kind: 'track',
    duration: typeof attrs?.durationInMillis === 'number'
      ? Math.round(attrs.durationInMillis / 1000)
      : undefined,
    hasCover: !!cover,
    provider: 'applemusic',
  };
}

export function mapLibraryTrack(providerId: string, track: any): ContentFolderItem {
  // Prefer catalog metadata over the (often sparser) library attributes for display,
  // but keep the library id so streaming/routing still treats this as a library track.
  const libAttrs = track?.attributes ?? track;
  const catalogAttrs = track?.relationships?.catalog?.data?.[0]?.attributes;
  const attrs = catalogAttrs ?? libAttrs;
  const id = encodeId(track?.id ?? libAttrs?.id ?? '');
  const name = attrs?.name ?? libAttrs?.name ?? 'Track';
  const artist = attrs?.artistName ?? libAttrs?.artistName ?? '';
  const album = attrs?.albumName ?? libAttrs?.albumName ?? '';
  const cover = extractArtwork(attrs) || extractArtwork(libAttrs);
  const durationMs = typeof attrs?.durationInMillis === 'number'
    ? attrs.durationInMillis
    : libAttrs?.durationInMillis;
  return {
    id: makeUri(providerId, 'track', id),
    audiopath: makeUri(providerId, 'track', id),
    name,
    title: name,
    artist,
    album,
    coverurl: cover,
    thumbnail: cover,
    type: FileType.File,
    tag: 'track',
    kind: 'track',
    duration: typeof durationMs === 'number' ? Math.round(durationMs / 1000) : undefined,
    hasCover: !!cover,
    provider: 'applemusic',
  };
}

export function mapAlbum(providerId: string, album: any): ContentFolderItem {
  const attrs = album?.attributes ?? album;
  const id = encodeId(album?.id ?? attrs?.id ?? '');
  const name = attrs?.name ?? 'Album';
  const artist = attrs?.artistName ?? '';
  const cover = extractArtwork(attrs);
  return {
    id: makeUri(providerId, 'album', id),
    audiopath: makeUri(providerId, 'album', id),
    name,
    title: name,
    artist,
    coverurl: cover,
    thumbnail: cover,
    type: FileType.PlaylistBrowsable,
    tag: 'album',
    kind: 'album',
    provider: 'applemusic',
  };
}

export function mapLibraryAlbum(providerId: string, album: any): ContentFolderItem {
  // Prefer catalog metadata when the library entry carries a catalog relationship.
  const libAttrs = album?.attributes ?? album;
  const catalogAttrs = album?.relationships?.catalog?.data?.[0]?.attributes;
  const attrs = catalogAttrs ?? libAttrs;
  const id = encodeId(album?.id ?? libAttrs?.id ?? '');
  const name = attrs?.name ?? libAttrs?.name ?? 'Album';
  const artist = attrs?.artistName ?? libAttrs?.artistName ?? '';
  const cover = extractArtwork(attrs) || extractArtwork(libAttrs);
  return {
    id: makeUri(providerId, 'library-album', id),
    audiopath: makeUri(providerId, 'library-album', id),
    name,
    title: name,
    artist,
    coverurl: cover,
    thumbnail: cover,
    type: FileType.PlaylistBrowsable,
    tag: 'album',
    kind: 'album',
    provider: 'applemusic',
  };
}

export function mapArtist(providerId: string, artistObj: any): ContentFolderItem {
  const attrs = artistObj?.attributes ?? artistObj;
  const id = encodeId(artistObj?.id ?? attrs?.id ?? '');
  const name = attrs?.name ?? 'Artist';
  const cover = extractArtwork(attrs);
  return {
    id: makeUri(providerId, 'artist', id),
    audiopath: makeUri(providerId, 'artist', id),
    name,
    title: name,
    artist: name,
    coverurl: cover,
    thumbnail: cover,
    type: FileType.PlaylistBrowsable,
    tag: 'artist',
    kind: 'artist',
    provider: 'applemusic',
  };
}

export function mapLibraryArtist(providerId: string, artistObj: any): ContentFolderItem {
  const relCatalogAttrs =
    artistObj?.relationships?.catalog?.data?.[0]?.attributes ??
    artistObj?.relationships?.catalog?.data?.[0];
  const attrs = relCatalogAttrs ?? artistObj?.attributes ?? artistObj;
  const id = encodeId(artistObj?.id ?? attrs?.id ?? '');
  const name = attrs?.name ?? 'Artist';
  const cover = extractArtwork(attrs);
  return {
    id: makeUri(providerId, 'library-artist', id),
    audiopath: makeUri(providerId, 'library-artist', id),
    name,
    title: name,
    artist: name,
    coverurl: cover,
    thumbnail: cover,
    type: FileType.PlaylistBrowsable,
    tag: 'artist',
    kind: 'artist',
    provider: 'applemusic',
  };
}

export function mapPlaylist(providerId: string, playlist: any): ContentFolderItem {
  const attrs = playlist?.attributes ?? playlist;
  const id = encodeId(playlist?.id ?? attrs?.id ?? '');
  const name = attrs?.name ?? 'Playlist';
  const cover = extractArtwork(attrs);
  return {
    id: makeUri(providerId, 'playlist', id),
    audiopath: makeUri(providerId, 'playlist', id),
    name,
    title: name,
    owner: attrs?.curatorName || '',
    owner_id: attrs?.curatorName || '',
    coverurl: cover,
    thumbnail: cover,
    type: FileType.PlaylistBrowsable,
    tag: 'playlist',
    kind: 'playlist',
    provider: 'applemusic',
  };
}

export function mapLibraryPlaylist(providerId: string, playlist: any): ContentFolderItem {
  // Apple often omits artwork on a library playlist. The catalog relationship is
  // too sparse to help (Music Assistant bypasses it too), so coverless playlists
  // get a server-side track-cover mosaic in the provider instead.
  const attrs = playlist?.attributes ?? playlist;
  const id = encodeId(playlist?.id ?? attrs?.id ?? '');
  const name = attrs?.name ?? 'Playlist';
  const cover = extractArtwork(attrs);
  return {
    id: makeUri(providerId, 'library-playlist', id),
    audiopath: makeUri(providerId, 'library-playlist', id),
    name,
    title: name,
    owner: attrs?.curatorName || attrs?.creatorName || '',
    owner_id: attrs?.curatorName || attrs?.creatorName || '',
    coverurl: cover,
    thumbnail: cover,
    type: FileType.PlaylistBrowsable,
    tag: 'playlist',
    kind: 'playlist',
    provider: 'applemusic',
  };
}

export function mapRecommendationItem(providerId: string, item: any): ContentFolderItem | null {
  switch (item?.type) {
    case 'albums':
      return mapAlbum(providerId, item);
    case 'playlists':
      return mapPlaylist(providerId, item);
    case 'artists':
      return mapArtist(providerId, item);
    case 'songs':
      return mapTrack(providerId, item);
    default:
      return null;
  }
}

/**
 * Find the album shelf in Apple's editorial home feed.
 *
 * The feed is a grouping whose tabs nest `editorial-elements` several levels deep,
 * each shelf carrying its items inline under `relationships.contents`. Shelves are
 * identified by what they hold (`resourceTypes`) rather than by their titles, which
 * are localized, or their ids, which rotate. Apple flags its lead shelf `emphasize`;
 * that is the new-release one, so it wins over document order.
 *
 * Returns the shelf's album entries, or an empty array when the feed has none.
 */
export function pickAlbumShelf(feed: any): any[] {
  const shelves: Array<{ emphasize: boolean; contents: any[] }> = [];

  const visit = (node: any, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 8) {
      return;
    }
    if (node.type === 'editorial-elements') {
      const attrs = node.attributes ?? {};
      const holdsAlbums = Array.isArray(attrs.resourceTypes)
        ? attrs.resourceTypes.includes('albums')
        : false;
      const contents = node.relationships?.contents?.data;
      if (holdsAlbums && Array.isArray(contents) && contents.length > 0) {
        shelves.push({ emphasize: attrs.emphasize === true, contents });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          visit(entry, depth + 1);
        }
      } else if (value && typeof value === 'object') {
        visit(value, depth + 1);
      }
    }
  };
  visit(feed, 0);

  const chosen = shelves.find((shelf) => shelf.emphasize) ?? shelves[0];
  return chosen?.contents ?? [];
}
