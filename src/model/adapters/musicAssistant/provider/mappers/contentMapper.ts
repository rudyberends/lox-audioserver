import type { Track, Album, Artist, Playlist } from '../../types/musicAssistantTypes';
import { FileType } from '@/core/loxone/types';
import { extractCover } from '../../utils/imageUtils';
import type { RecentItem, ServiceFolderItem } from '@/core/types/content';
import { buildAudiopath } from '@/core/loxone/mediaMapping';
import { detectMediaType } from '../../utils/detectMediaType';

type LoxoneTag = 'track' | 'album' | 'artist' | 'playlist';

const FILE_TYPE_MAP: Record<LoxoneTag, FileType> = {
  track: FileType.File,
  album: FileType.PlaylistBrowsable,
  artist: FileType.PlaylistBrowsable,
  playlist: FileType.PlaylistBrowsable,
};

/**
 * Generic mapper for any media object (Track, Album, Artist, Playlist).
 * Automatically extracts cover, artist/album, and Loxone-compatible audiopath.
 */
function mapBaseItem(
  obj: Partial<Track | Album | Artist | Playlist>,
  tag: LoxoneTag,
  fileType: FileType,
): ServiceFolderItem {
  const mediaUri = obj.uri ?? (obj as any).item_id ?? '';
  const coverurl = extractCover(obj);
  const name = (obj as any).name ?? (obj as any).title ?? 'Unknown';

  const audiopath = buildAudiopath(mediaUri, tag);

  return {
    id: audiopath,
    name,
    title: name,
    artist: (obj as any).artists?.[0]?.name ?? (obj as any).artist ?? '',
    album: (obj as any).album?.name ?? (obj as any).album ?? '',
    tag,
    type: fileType,
    audiopath,
    coverurl,
    thumbnail: coverurl,
    provider: 'musicassistant',
  };
}

/** Generic mapper entrypoint */
export function mapMediaItem<T extends Track | Album | Artist | Playlist>(
  obj: T,
  tag: LoxoneTag,
): ServiceFolderItem {
  return mapBaseItem(obj, tag, FILE_TYPE_MAP[tag]);
}

/**
 * Maps a Music Assistant "recently played" entry to a Loxone-compatible format.
 */
export function mapRecentlyPlayedItem(obj: any): RecentItem {
  const media = obj.media_item ?? obj;
  const coverurl = extractCover(media);
  const mediaType = detectMediaType(media.uri);

  // Use the universal Loxone audio path builder
  const audiopath = buildAudiopath(media.uri, mediaType);

  return {
    album: media.album?.name ?? media.album ?? '',
    artist: Array.isArray(media.artists) ? media.artists[0]?.name ?? '' : media.artist ?? '',
    audiopath,
    coverurl,
    owner_id: mediaType === 'radio' ? 'tunein' : 'spotify',
    service: mediaType === 'radio' ? 'tunein' : 'spotify',
    serviceType: mediaType === 'radio' ? 1 : 3,
    title: media.name ?? media.title ?? 'Unknown',
    type: mediaType === 'track' || mediaType === 'radio' ? FileType.File : FileType.PlaylistBrowsable,
  };
}