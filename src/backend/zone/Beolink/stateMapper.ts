import { PlayerStatus, AudioPlaybackMode } from '../loxoneTypes';
import { NotificationData, PrimaryExperience } from './types';

/**
 * Converts remote image URLs into proxied cover art served via the AudioServer.
 */
function buildCoverUrl(audioServerIp?: string, originalUrl?: string, album?: string): string {
  if (!audioServerIp || !originalUrl) return '';
  const encodedUrl = encodeURIComponent(originalUrl);
  const cacheBust = encodeURIComponent(album || 'x');
  const url = `http://${audioServerIp}:7091/cors-proxy?url=${encodedUrl}&id=${cacheBust}`;
  return url;
}

/**
 * Maps Beolink notification payloads to the Loxone Track structure consumed by the UI.
 */
type MapperOptions = {
  audioServerIp?: string;
  onPrimaryExperienceChange?: (experience?: PrimaryExperience | null) => void;
};

type MapperArg = string | MapperOptions | undefined;

function resolveOptions(arg: MapperArg): MapperOptions {
  if (typeof arg === 'string' || typeof arg === 'undefined') {
    return { audioServerIp: arg };
  }
  return arg ?? {};
}

export function mapNotificationToTrack(
  type: string,
  data: NotificationData,
  arg?: MapperArg,
): Partial<PlayerStatus> {
  const options = resolveOptions(arg);
  const audioServerIp = options.audioServerIp;

  switch (type) {
    case 'SOURCE':
      if (data.primaryExperience) {
        options.onPrimaryExperienceChange?.(data.primaryExperience);
      }
      return {
        power: 'on',
        title: data.friendlyName || 'Unknown Source',
      };

    case 'VOLUME':
      return { volume: data.speaker?.level };

    case 'NOW_PLAYING_STORED_MUSIC':

      return {
        audiotype: 4,
        artist: data.artist,
        album: data.album,
        title: data.name,
        duration: data.duration,
        coverurl: buildCoverUrl(audioServerIp, data.trackImage?.[0]?.url, data.name),
      };

    case 'PROGRESS_INFORMATION': {
      const state = (data.state ?? '').toString().toLowerCase();
      const trackInfo: Partial<PlayerStatus> = {
        mode: state as AudioPlaybackMode,
        time: Number(data.position ?? 0),
      };

      if (data.playQueueItemId && data.playQueueItemId === 'AUX') {
        trackInfo.audiotype = 3;
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
        coverurl: buildCoverUrl(audioServerIp, data.image?.[0]?.url, data.name),
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

    case 'SOURCE_EXPERIENCE_CHANGED':
      options.onPrimaryExperienceChange?.(data.primaryExperience ?? null);
      return {};

    default:
      return {};
  }
}
