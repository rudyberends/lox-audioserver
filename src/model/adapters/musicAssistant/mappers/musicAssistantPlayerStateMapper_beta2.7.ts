import logger from '@/utils/troxorLogger';
import { AudioType, RepeatMode, FileType, AudioPlaybackMode, AudioPowerState } from '@/core/loxone/types';
import type { ZoneState } from '@/runtime/zones/types';
import { ensureString, mapArtists, normalizeUri } from '../utils/mapperUtils';
import { extractCover } from '../utils/imageUtils';
import { Player, PlayerQueue } from '../types/musicAssistantTypes';
import { safeString, safeNumber } from '@/core/utils/media';

/**
 * Result structure returned to ZoneRuntime.
 */
interface QueueMappingResult {
  queue: ZoneState['queue'];
  trackUpdate: Partial<ZoneState>;
}

/* -------------------------------------------------------------------------- */
/* Player → State mapping                                                     */
/* -------------------------------------------------------------------------- */

export function mapPlayerToState(
  zoneId: number,
  player: Player,
): Partial<ZoneState> {
  const state = safeString(player.playback_state ?? player.type).toLowerCase();
  const isPlaying = state === 'playing';
  const media = player.current_media;
  const title = safeString(media?.title ?? '');
  const artist = safeString(media?.artist ?? '');
  const album = safeString(media?.album ?? '');
  const coverurl = safeString(media?.image_url ?? '');
  const duration = safeNumber(media?.duration, { min: 0 });
  const time = safeNumber(media?.elapsed_time ?? player.elapsed_time, { min: 0 });
  return {
    playerid: zoneId,
    mode: isPlaying ? AudioPlaybackMode.Play : AudioPlaybackMode.Pause,
    power: AudioPowerState.On,
    volume: safeNumber(player.volume_level, { min: 0, max: 100, round: true }),
    title,
    artist,
    album,
    coverurl,
    duration,
    time,
  };
}

/* -------------------------------------------------------------------------- */
/* Queue mapping                                                              */
/* -------------------------------------------------------------------------- */

export function mapQueueToState(
  zoneId: number,
  queue: PlayerQueue,
): QueueMappingResult | null {
  try {
    if (!queue?.current_item) {
      return null;
    }
    const cur = queue.current_item;
    const media = cur.media_item;
    const repeat = safeString(queue.repeat_mode).toLowerCase();

    const repeatMode: RepeatMode =
      repeat === 'one'
        ? RepeatMode.Track
        : repeat === 'all'
          ? RepeatMode.Queue
          : RepeatMode.NoRepeat;

    const shuffle = queue.shuffle_enabled ? 1 : 0;
    const queueshuffle = queue.shuffle_enabled ? true : false;
    const coverurl = safeString(queue.current_item.image?.path ?? '');

    const items = Array.isArray(queue.items)
      ? queue.items.map((item, i) => mapQueueItem(item, i))
      : [];

    const mappedQueue: ZoneState['queue'] = {
      id: zoneId,
      items,
      shuffle: queueshuffle,
      start: 0,
      totalitems: items.length,
    };

    const isPlaying = queue.state === 'playing';

    const trackUpdate: Partial<ZoneState> = {
      playerid: zoneId,
      mode: isPlaying ? AudioPlaybackMode.Play : AudioPlaybackMode.Pause,
      title: safeString(media?.name ?? ''),
      //artist: cur.media_item?.,
      //album: ensureString(media?.album ?? cur.album ?? ''),
      coverurl,
      duration: safeNumber(cur.duration, { min: 0 }),
      time: safeNumber(queue.elapsed_time, { min: 0 }),
      plrepeat: repeatMode,
      plshuffle: shuffle,
      clientState: 'on',
      type: FileType.File,
      qid: safeString(cur.queue_item_id),
      qindex: findCurrentIndex(items, cur.queue_item_id),
      sourceName: 'Music Assistant',
      //name: 'Music Assistant',
      audiopath: normalizeUri(media?.uri),
      audiotype: AudioType.File,
    };

    return { queue: mappedQueue, trackUpdate };
  } catch (err) {
    logger.warn(`[mapQueueToState] Failed to map queue for zone ${zoneId}: ${String(err)}`);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export function mapQueueItem(item: any, index: number) {
  const media = item?.media_item ?? item ?? {};
  const audiopath = `spotify:track:0/${media.uri ?? ''}`;
  const coverurl = extractCover(media, 64); // small covers for queueitems
  const uniqueId = safeString(item?.queue_item_id) || btoa(`${audiopath}-${index}`).slice(0, 32);

  return {
    album: ensureString(media.album ?? ''),
    artist: ensureString(mapArtists(media)),
    audiopath,
    audiotype: 5,
    coverurl,
    duration: safeNumber(media.duration ?? item?.duration, { min: 0 }),
    qindex: index,
    station: '',
    title: safeString(media.title ?? media.name ?? item?.name ?? ''),
    unique_id: uniqueId,
    user: 'nouser',
  };
}

function findCurrentIndex(items: { unique_id: string }[], queueItemId?: string): number {
  if (!queueItemId) {
    return 0;
  }
  const idx = items.findIndex((i) => i.unique_id === queueItemId);
  return idx >= 0 ? idx : 0;
}