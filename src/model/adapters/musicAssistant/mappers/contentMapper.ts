import type { Track, Album, Artist, Playlist } from '../types/musicAssistantTypes';
import { FileType } from '@/core/loxone/types';
import { mapArtists, normalizeUri } from '../utils/mapperUtils';
import { extractCover } from '../utils/imageUtils';
import { ServiceFolderItem } from '@/core/types/content';

/**
 * Converts a Track to a Loxone-compatible ServiceFolderItem.
 */
export function mapTrack(track: Track, providerId: string): ServiceFolderItem {
  const coverurl = extractCover(track);
  const artist = mapArtists(track);
  const albumName =
    typeof track.album === 'object'
      ? (track.album as { name?: string })?.name ?? ''
      : (track.album as string) ?? '';

  return {
    id: track.uri ?? track.item_id ?? '',
    name: track.name ?? '',
    title: track.name ?? '',
    artist,
    album: albumName,
    tag: 'track',
    type: FileType.File,
    audiopath: track.uri ?? '',
    duration: Number(track.duration ?? 0),
    coverurl,
    thumbnail: coverurl,
    provider: providerId,
  };
}

/**
 * Converts an Album to a Loxone-compatible ServiceFolderItem.
 */
export function mapAlbum(album: Album, providerId: string): ServiceFolderItem {
  const coverurl = extractCover(album);
  const artist = mapArtists(album);
  const id = normalizeUri(album.uri);
  return {
    id: id,
    name: album.name ?? '',
    title: album.name ?? '',
    artist,
    tag: 'album',
    type: FileType.PlaylistBrowsable,
    audiopath: id,
    coverurl,
    thumbnail: coverurl,
    provider: providerId,
  };
}

/**
 * Converts an Artist to a Loxone-compatible ServiceFolderItem.
 */
export function mapArtist(artist: Artist, providerId: string): ServiceFolderItem {
  const coverurl = extractCover(artist);
  const id = normalizeUri(artist.uri);
  return {
    id: id,
    name: artist.name ?? '',
    title: artist.name ?? '',
    tag: 'artist',
    type: FileType.PlaylistBrowsable,
    audiopath: id,
    coverurl,
    thumbnail: coverurl,
    provider: providerId,
  };
}

/**
 * Converts a Playlist to a Loxone-compatible ServiceFolderItem.
 */
export function mapPlaylist(playlist: Playlist, providerId: string): ServiceFolderItem {
  const coverurl = extractCover(playlist);
  const id = normalizeUri(playlist.uri);
  return {
    id: id,
    name: playlist.name ?? '',
    title: playlist.name ?? '',
    tag: 'playlist',
    type: FileType.PlaylistBrowsable,
    audiopath: id,
    coverurl,
    thumbnail: coverurl,
    provider: providerId,
  };
}

/**
 * Converts a "Recently Played" entry to a Loxone-compatible ServiceFolderItem.
 */
export function mapRecentlyPlayedItem(obj: any, providerId: string, index = 0): ServiceFolderItem {
  const media = obj.media_item ?? obj;
  const coverurl = extractCover(media);
  const mediaType =
    media.media_type?.toLowerCase?.() ??
    media.type?.toLowerCase?.() ??
    media.category?.toLowerCase?.() ??
    '';

  const id = `library:local:track:${1000}${index}}`;

  return {
    name: media.name ?? media.title ?? 'Unknown',
    title: media.name ?? media.title ?? 'Unknown',
    type: mediaType === 'playlist' ? FileType.Playlist : FileType.File,
    audiopath: id,
    coverurl,
    service: 'library',
  };
}


