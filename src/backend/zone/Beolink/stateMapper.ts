import { Track } from '../zonemanager';
import { NotificationData } from './types';

function buildCoverUrl(audioServerIp?: string, originalUrl?: string, album?: string): string {
  if (!audioServerIp || !originalUrl) return '';
  const encodedUrl = encodeURIComponent(originalUrl);
  const cacheBust = encodeURIComponent(album || 'x');
  return `http://${audioServerIp}:7091/cors-proxy?url=${encodedUrl}&id=${cacheBust}`;
}

export function mapNotificationToTrack(
  type: string,
  data: NotificationData,
  audioServerIp?: string,
): Partial<Track> {
  switch (type) {
    case 'SOURCE':
      return {
        power: 'on',
        title: data.friendlyName || 'Unknown Source',
      };

    case 'VOLUME':
      return { volume: data.speaker?.level };

    case 'NOW_PLAYING_STORED_MUSIC':
      return {
        audiotype: 2,
        artist: data.artist,
        album: data.album,
        title: data.name,
        duration: data.duration,
        coverurl: buildCoverUrl(audioServerIp, data.trackImage?.[0]?.url, data.album),
      };

    case 'PROGRESS_INFORMATION': {
      const trackInfo: Partial<Track> = {
        mode: data.state,
        time: data.position,
      };

      if (data.playQueueItemId && data.playQueueItemId === 'AUX') {
        trackInfo.audiotype = 1;
        trackInfo.duration = 0;
      }
      return trackInfo;
    }

    case 'NOW_PLAYING_NET_RADIO':
      return {
        audiotype: 1,
        artist: data.liveDescription,
        album: data.album,
        title: data.name,
        duration: 0,
        coverurl: buildCoverUrl(audioServerIp, data.image?.[0]?.url, data.album),
      };

    case 'SHUTDOWN':
    case 'NOW_PLAYING_ENDED':
      return {
        audiotype: 0,
        artist: '',
        album: '',
        title: '',
        duration: 0,
        coverurl: '',
      };

    default:
      return {};
  }
}
