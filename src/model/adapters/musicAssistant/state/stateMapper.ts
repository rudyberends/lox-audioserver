import logger from '@/utils/troxorLogger';
import { AudioType, RepeatMode, FileType, AudioPlaybackMode, AudioPowerState } from '@/core/loxone/types';
import type { ZoneState } from '@/runtime/zones/types';
import { ensureString, mapArtists } from '../utils/mapperUtils';
import { extractCover } from '../utils/imageUtils';
import { PlayerQueue } from '../types/musicAssistantTypes';
import { safeString, safeNumber } from '@/core/utils/media';
import { buildAudiopath } from '@/core/loxone/mediaMapping';

/**
 * Result structure returned to ZoneRuntime.
 */
interface QueueMappingResult {
  queue: ZoneState['queue'];
  trackUpdate: Partial<ZoneState>;
}

/* -------------------------------------------------------------------------- */
/* Player → Track mapping                                                     */
/* -------------------------------------------------------------------------- */

export function mapPlayerToState(
  zoneId: number,
  player: { state?: string; volume_level?: number },
): Partial<ZoneState> {
  const isPlaying = safeString(player.state).toLowerCase() === 'playing';
  return {
    playerid: zoneId,
    mode: isPlaying ? AudioPlaybackMode.Play : AudioPlaybackMode.Pause,
    power: AudioPowerState.On,
    volume: safeNumber(player.volume_level, { min: 0, max: 100, round: true }),
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
    const itemsArray = Array.isArray(queue?.items) ? queue.items : [];
    const cur = queue.current_item ?? itemsArray[0];
    const media = cur?.media_item ?? cur ?? {};

    // ⬇️ Fallback: skip only if absolutely no media info is available
    if (!cur && !media) {
      logger.debug(`[mapQueueToState] No current media or queue items for zone ${zoneId}`);
      return null;
    }

    const artist = mapArtists(media);
    const repeat = safeString(queue.repeat_mode).toLowerCase();
    const repeatMode: RepeatMode =
      repeat === 'one'
        ? RepeatMode.Track
        : repeat === 'all'
          ? RepeatMode.Queue
          : RepeatMode.NoRepeat;

    const shuffle = !!queue.shuffle_enabled;
    const cover = extractCover(media, 265);
    const audioType = AudioType.File;

    // Queue is optional but still built if present
    const mappedQueue: ZoneState['queue'] = {
      id: zoneId,
      items: Array.isArray(itemsArray)
        ? itemsArray.map((item, i) => mapQueueItem(item, i))
        : [],
      shuffle,
      start: 0,
      totalitems: itemsArray.length,
    };

    const trackUpdate: Partial<ZoneState> = {
      playerid: zoneId,
      title: safeString(media.name ?? cur?.name ?? ''),
      artist,
      album: safeString(media.album ?? ''),
      coverurl: cover,
      duration: safeNumber(cur?.duration ?? media.duration, { min: 0 }),
      time: safeNumber(queue.elapsed_time ?? 0, { min: 0 }),
      plrepeat: repeatMode,
      plshuffle: shuffle ? 1 : 0,
      clientState: 'on',
      type: FileType.Playlist,
      qid: safeString(cur?.queue_item_id ?? ''),
      qindex: findCurrentIndex(mappedQueue.items, cur?.queue_item_id),
      sourceName: 'Music Assistant',
      name: 'Music Assistant',
      audiopath: buildAudiopath(media?.uri ?? '', 'track'),
      audiotype: audioType,
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
  const audiopath = buildAudiopath(media.uri, 'track');
  const coverurl = extractCover(media, 16);
  const uniqueId = safeString(item?.queue_item_id) || btoa(`${audiopath}-${index}`).slice(0, 32);

  return {
    album: ensureString(media.album ?? ''),
    artist: ensureString(mapArtists(media)),
    audiopath: audiopath.replace(/^spotify@[^:]+:/i, 'spotify:'),
    audiotype: AudioType.Spotify,
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