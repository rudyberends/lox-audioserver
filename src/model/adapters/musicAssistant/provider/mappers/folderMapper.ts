import { extractCover } from '../../utils/imageUtils';
import type { ServiceFolderItem, ServiceFolderResponse } from '@/core/types/content';
import { mapMediaItem } from './contentMapper';
import { Track } from '../../types/musicAssistantTypes';


export function mapFolderResponse(
  type: 'album' | 'playlist' | 'artist' | 'radio',
  items: any[],
  offset: number,
): ServiceFolderResponse {
  const mapped = items.map(obj => mapMediaItem(obj, type)).filter((i): i is ServiceFolderItem => Boolean(i));

  return {
    id: type,
    name: `${type[0].toUpperCase() + type.slice(1)}s`,
    service: 'musicassistant',
    start: offset,
    totalitems: mapped.length,
    items: mapped,
  };
}

export function mapDetailResponse(
  type: 'album' | 'playlist' | 'artist',
  info: any,
  tracks: Track[],
  offset: number,
): ServiceFolderResponse {
  const coverurl = extractCover(info);
  const artist = Array.isArray(info?.artists) ? info.artists[0]?.name : info.artist ?? '';
  return {
    id: info.uri ?? '',
    name: info.name ?? '',
    service: 'musicassistant',
    artist,
    coverurl,
    thumbnail: coverurl,
    tag: type,
    type: 7,
    start: offset,
    totalitems: tracks.length,
    items: tracks.map(t => mapMediaItem(t, 'track')),
  };
}