/**
 * Pure mapping helpers that turn SoundCloud `api-v2` objects into Loxone
 * ContentFolderItem shapes. No instance state, no network — just translation.
 * Each mapper takes the owning provider id so generated audiopaths stay scoped
 * to that provider instance.
 */

import type { ContentFolderItem } from '@/ports/ContentTypes';
import type {
  SoundCloudPlaylist,
  SoundCloudTrack,
  SoundCloudUser,
} from '@/adapters/content/providers/soundcloud/soundcloudClient';

export enum FileType {
  Folder = 1,
  File = 2,
  PlaylistBrowsable = 7,
}

/** Build a provider-scoped audiopath/id, e.g. `spotify@sc1:track:12345`. */
export function makeUri(providerId: string, type: string, id: string): string {
  return `${providerId}:${type}:${id}`;
}

/**
 * Upgrade a SoundCloud artwork/avatar URL to a larger variant. SoundCloud
 * serves `-large.jpg` (100px) by default; `-t500x500.jpg` is the documented
 * high-res swap the web player uses.
 */
export function upscaleArtwork(url: string | null | undefined): string {
  const raw = (url || '').trim();
  if (!raw) {
    return '';
  }
  // Skip the generic default avatar; it has no high-res variant and 404s.
  if (raw.includes('default_avatar')) {
    return '';
  }
  return raw.replace('-large.', '-t500x500.');
}

/** Best-effort artist name from a track's publisher metadata or uploader. */
function trackArtist(track: SoundCloudTrack): string {
  const publisher = track.publisher_metadata?.artist?.trim();
  if (publisher) {
    return publisher;
  }
  return track.user?.username?.trim() || '';
}

export function mapTrack(providerId: string, track: SoundCloudTrack): ContentFolderItem {
  const id = String(track.id);
  const name = String(track.title ?? 'Track');
  const cover = upscaleArtwork(track.artwork_url) || upscaleArtwork(track.user?.avatar_url);
  return {
    id: makeUri(providerId, 'track', id),
    audiopath: makeUri(providerId, 'track', id),
    name,
    title: name,
    artist: trackArtist(track),
    album: track.publisher_metadata?.album_title?.trim() || '',
    coverurl: cover,
    thumbnail: cover,
    type: FileType.File,
    tag: 'track',
    // SoundCloud durations are milliseconds; Loxone expects seconds.
    duration: typeof track.duration === 'number' ? Math.round(track.duration / 1000) : undefined,
    hasCover: Boolean(cover),
    provider: 'soundcloud',
  };
}

export function mapArtist(providerId: string, user: SoundCloudUser): ContentFolderItem {
  const id = String(user.id);
  const name = String(user.username ?? 'Artist');
  const cover = upscaleArtwork(user.avatar_url);
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
    provider: 'soundcloud',
  };
}

export function mapPlaylist(providerId: string, playlist: SoundCloudPlaylist): ContentFolderItem {
  const id = String(playlist.id);
  const name = String(playlist.title ?? 'Playlist').replace(/^Related tracks: /, '');
  const owner = playlist.user?.username ?? '';
  const cover =
    upscaleArtwork(playlist.artwork_url) || upscaleArtwork(playlist.calculated_artwork_url);
  return {
    id: makeUri(providerId, 'playlist', id),
    audiopath: makeUri(providerId, 'playlist', id),
    name,
    title: name,
    artist: owner,
    owner,
    owner_id: owner,
    coverurl: cover,
    thumbnail: cover,
    type: FileType.PlaylistBrowsable,
    tag: 'playlist',
    provider: 'soundcloud',
  };
}
