import logger from '@/utils/troxorLogger';
import { AudioType, AudioPlaybackMode, AudioPowerState, FileType } from '@/core/types/loxone';
import type { NotificationData, PrimaryExperience } from '../types/notifications';
import { ZoneState } from '@/runtime/zones/types';
import { safeNumber, safeString } from '@/core/utils/media';

const TAG = '[BeoLinkMapper]';

const eventTypes = [
  'SOURCE',
  'VOLUME',
  'NOW_PLAYING_STORED_MUSIC',
  'PROGRESS_INFORMATION',
  'NOW_PLAYING_NET_RADIO',
  'STANDBY',
  'NOW_PLAYING_ENDED',
  'SHUTDOWN',
  'SOURCE_EXPERIENCE_CHANGED',
] as const;
type BeoLinkEventType = typeof eventTypes[number];

function isBeoEvent(v: unknown): v is BeoLinkEventType {
  return typeof v === 'string' && eventTypes.includes(v as BeoLinkEventType);
}

/** Adds a cache-busting query param to cover-art URLs. */
export function buildCoverUrlWithCacheBust(
  baseUrl?: string,
  trackName?: string,
  artist?: string,
  album?: string,
): string {
  if (!baseUrl) {
    return '';
  }
  const [beforeTmp, afterTmp] = baseUrl.split('//tmp');
  const safeBefore = beforeTmp.replace(/([^:]\/)\/+/g, '$1');
  const safeUrl = afterTmp ? `${safeBefore}//tmp${afterTmp}` : safeBefore;
  const key = `${trackName ?? ''}_${artist ?? ''}_${album ?? ''}`;
  const id = encodeURIComponent(key.trim() || Date.now().toString());
  const sep = safeUrl.includes('?') ? '&' : '?';
  return `${safeUrl}${sep}v=${id}`;
}

/** Maps a single BeoLink notification into a ZoneState fragment. */
export function mapBeoLinkNotification(
  type: string,
  data: NotificationData,
  audioServerIp?: string,
  onPrimaryExperienceChange?: (exp?: PrimaryExperience | null) => void,
): Partial<ZoneState> | null {
  const state: Partial<ZoneState> = {};
  const t = (type ?? '').trim().toUpperCase();
  const event = isBeoEvent(t) ? t : undefined;

  try {
    switch (event) {
      case 'SOURCE': {
        if (data.primaryExperience) {
          onPrimaryExperienceChange?.(data.primaryExperience);
        }
        state.adapterProps = { currentSourceId: data.primaryExperience?.source?.id };
        state.power = AudioPowerState.On;
        state.title = safeString(data.friendlyName) || 'Unknown Source';
        break;
      }

      case 'VOLUME': {
        const level = safeNumber(data?.speaker?.level, { min: 0, max: 100, round: true });
        state.volume = level;
        break;
      }

      case 'NOW_PLAYING_STORED_MUSIC': {
        const artUrl = safeString(data.trackImage?.[0]?.url);
        const coverurl = buildCoverUrlWithCacheBust(artUrl, safeString(data.name), safeString(data.artist), safeString(data.album));
        Object.assign(state, {
          audiotype: AudioType.File,
          type: FileType.Playlist,
          artist: safeString(data.artist),
          album: safeString(data.album),
          title: safeString(data.name),
          duration: safeNumber(data.duration, { min: 0 }),
          mode: AudioPlaybackMode.Play,
          coverurl,
        });
        break;
      }

      case 'PROGRESS_INFORMATION': {
        const lower = safeString(data.state).toLowerCase();
        const mode: AudioPlaybackMode =
          lower === 'pause'
            ? AudioPlaybackMode.Pause
            : lower === 'play'
              ? AudioPlaybackMode.Play
              : AudioPlaybackMode.Stop;
        state.mode = mode;
        state.time = safeNumber(data.position, { min: 0 });
        if (data.playQueueItemId === 'AUX') {
          state.audiotype = AudioType.LineIn;
          state.duration = 0;
        }
        break;
      }

      case 'NOW_PLAYING_NET_RADIO': {
        const cover = safeString(data.image?.[0]?.url);
        Object.assign(state, {
          audiotype: AudioType.Radio,
          artist: safeString(data.liveDescription),
          album: safeString(data.album),
          title: safeString(data.name),
          duration: 0,
          mode: AudioPlaybackMode.Play,
          coverurl: cover,
        });
        break;
      }

      case 'SHUTDOWN':
      case 'NOW_PLAYING_ENDED':
      case 'STANDBY': {
        Object.assign(state, {
          audiotype: AudioType.File,
          artist: '',
          album: '',
          title: '',
          duration: 0,
          mode: AudioPlaybackMode.Stop,
          power: AudioPowerState.Off,
          coverurl: '',
        });
        break;
      }

      case 'SOURCE_EXPERIENCE_CHANGED': {
        onPrimaryExperienceChange?.(data.primaryExperience ?? null);
        break;
      }

      default:
        logger.debug(`${TAG} Ignored notification type: ${t}`);
    }
  } catch (err) {
    logger.error(`${TAG} Failed to parse notification: ${(err as Error).message}`);
  }

  // Sanitize numeric fields
  if (typeof state.volume === 'number') {
    state.volume = safeNumber(state.volume, { min: 0, max: 100, round: true });
  }
  if (typeof state.time === 'number') {
    state.time = safeNumber(state.time, { min: 0 });
  }
  if (typeof state.duration === 'number') {
    state.duration = safeNumber(state.duration, { min: 0 });
  }
  if (state.coverurl && typeof state.coverurl !== 'string') {
    state.coverurl = '';
  }

  return Object.keys(state).length > 0 ? state : null;
}
