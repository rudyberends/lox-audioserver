import type { Track, Album, Artist, Playlist, Radio } from '../../types/musicAssistantTypes';
import { FileType } from '@/core/loxone/types';
import { extractCover } from '../../utils/imageUtils';
import type { RecentItem, ServiceFolderItem } from '@/core/types/content';
import { buildAudiopath } from '@/core/loxone/mediaMapping';
import { detectMediaType } from '../../utils/detectMediaType';

/* -------------------------------------------------------------------------- */
/* Types and constants                                                        */
/* -------------------------------------------------------------------------- */

type LoxoneTag = 'track' | 'album' | 'artist' | 'playlist' | 'radio';

const FILE_TYPE_MAP: Record<LoxoneTag, FileType> = {
  track: FileType.File,
  album: FileType.PlaylistBrowsable,
  artist: FileType.PlaylistBrowsable,
  playlist: FileType.PlaylistBrowsable,
  radio: FileType.Playlist,
};

/* -------------------------------------------------------------------------- */
/* Generic media item mapping (all types incl. radio)                         */
/* -------------------------------------------------------------------------- */

export function mapMediaItem(
  obj: Partial<Track | Album | Artist | Playlist | Radio>,
  tag: LoxoneTag,
): ServiceFolderItem {
  const mediaUri = (obj as any).uri ?? (obj as any).item_id ?? '';
  const coverurl = extractCover(obj);
  const name = (obj as any).name ?? (obj as any).title ?? 'Unknown';
  const audiopath = buildAudiopath(mediaUri, tag);

  return {
    id: audiopath,
    name,
    title: name,
    artist: tag === 'radio' ? '' : (obj as any).artists?.[0]?.name ?? (obj as any).artist ?? '',
    album: tag === 'radio' ? '' : (obj as any).album?.name ?? (obj as any).album ?? '',
    tag,
    type: FILE_TYPE_MAP[tag],
    audiopath,
    coverurl,
    thumbnail: coverurl,
    provider: 'musicassistant',
  };
}

/* -------------------------------------------------------------------------- */
/* Recently played                                                            */
/* -------------------------------------------------------------------------- */

export function mapRecentlyPlayedItem(obj: any): RecentItem {
  const media = obj.media_item ?? obj;
  const coverurl = extractCover(media);
  const mediaType = detectMediaType(media.uri);
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
    type:
      mediaType === 'track' || mediaType === 'radio'
        ? FileType.File
        : FileType.PlaylistBrowsable,
  };
}