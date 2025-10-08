import { PlayerStatus, AudioPlaybackMode } from '../loxoneTypes';
import { NotificationData } from './types';

/**
 * Converts remote image URLs into proxied cover art served via the AudioServer.
 */
function buildCoverUrl(audioServerIp?: string, originalUrl?: string, album?: string): string {
  if (!audioServerIp || !originalUrl) return '';
  const encodedUrl = encodeURIComponent(originalUrl);
  const cacheBust = encodeURIComponent(album || 'x');
  return `http://${audioServerIp}:7091/cors-proxy?url=${encodedUrl}&id=${cacheBust}`;
}

/**
 * Maps Beolink notification payloads to the Loxone Track structure consumed by the UI.
 */
export function mapNotificationToTrack(
  type: string,
  data: NotificationData,
  audioServerIp?: string,
): Partial<PlayerStatus> {
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
      const state = (data.state ?? '').toString().toLowerCase();
      const mode: AudioPlaybackMode = state === 'playing'
        ? 'play'
        : state === 'paused'
          ? 'pause'
          : state === 'resume' || state === 'resuming'
            ? 'resume'
            : 'stop';

      const trackInfo: Partial<PlayerStatus> = {
        mode,
        time: Number(data.position ?? 0),
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
