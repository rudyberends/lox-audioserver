import { PlayerStatus, AudioType, RepeatMode, FileType } from '../loxoneTypes';
import { normalizeMediaUri } from '../../provider/musicAssistant/utils';

/**
 * Combined queue payload returned to the ZoneManager after mapping Music Assistant state.
 */
interface QueueMappingResult {
  trackUpdate: Partial<PlayerStatus>;
  items: {
    album: string;
    artist: string;
    audiopath: string;
    audiotype: number;
    coverurl: string;
    duration: number;
    qindex: number;
    station: string;
    title: string;
    unique_id: string;
    user: string;
  }[];
  shuffleEnabled: boolean;
}

/** Maps player-level updates to the smaller Track diff ingested by the ZoneManager. */
export function mapPlayerToTrack(loxoneZoneId: number, player: any): Partial<PlayerStatus> {
  const isPlaying = player.state === 'playing';

  return {
    playerid: loxoneZoneId,
    mode: isPlaying ? 'play' : 'pause',
    power: 'on',
    volume: Number(player.volume_level ?? 0),
  };
}

/** Coerces Music Assistant string-like values (objects/arrays) to display strings. */
function ensureString(value: any): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (!value) return '';

  if (typeof value === 'object') {
    if (typeof value.name === 'string') return value.name;
    if (typeof value.title === 'string') return value.title;
    if (Array.isArray(value)) {
      return value.map((entry) => ensureString(entry)).filter(Boolean).join(', ');
    }
  }

  return '';
}

/** Produces a comma-separated artist string from Music Assistant data. */
function mapArtists(source: any): string {
  if (Array.isArray(source?.artists) && source.artists.length > 0) {
    return source.artists
      .map((artist: any) => ensureString(artist))
      .filter(Boolean)
      .join(', ');
  }

  const directArtist = source?.artist ?? source;
  return ensureString(directArtist);
}

/** Returns the first truthy URL candidate, skipping empty values. */
function firstValidUrl(...candidates: Array<string | undefined | null>): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return '';
}

/** Reads the first image URL from a standard metadata.images array. */
function extractImageFromMetadata(metadata: any): string {
  if (!metadata) return '';
  if (Array.isArray(metadata.images)) {
    for (const img of metadata.images) {
      const url = ensureString(img?.url ?? img?.path ?? img);
      if (url) return url;
    }
  }
  return '';
}

/** Reads the first image URL from legacy list structures. */
function extractImageFromList(list: any): string {
  if (!list) return '';
  if (Array.isArray(list)) {
    for (const entry of list) {
      const url = ensureString(entry?.url ?? entry?.path ?? entry);
      if (url) return url;
    }
  }
  return '';
}

/** Derives a coarse audio type used by the UI based on URI/provider hints. */
function determineAudioType(media: any, fallback: any): number {
  const uriRaw: string = ensureString(media?.uri ?? fallback?.uri ?? '');
  const uri = uriRaw.toLowerCase();

  if (!uri) {
    return AudioType.File;
  }

  if (uri.startsWith('library://')) {
    if (uri.includes('/playlist/')) {
      return AudioType.Playlist;
    }
    return AudioType.File;
  }

  if (uri.startsWith('library:local:')) {
    if (uri.includes(':playlist:')) {
      return AudioType.Playlist;
    }
    return AudioType.File;
  }

  if (uri.startsWith('playlist://')) {
    return AudioType.Playlist;
  }

  if (uri.startsWith('linein:')) {
    return AudioType.LineIn;
  }

  if (uri.startsWith('airplay:')) {
    return AudioType.AirPlay;
  }

  if (uri.startsWith('spotify:')) {
    return AudioType.Spotify;
  }

  if (uri.startsWith('soundsuit@') || uri.startsWith('http://') || uri.startsWith('https://')) {
    return AudioType.Radio;
  }

  if (uri.startsWith('apple_music://') || uri.startsWith('tidal://') || uri.startsWith('deezer://')) {
    return AudioType.File;
  }

  const providerMappings = media?.provider_mappings;
  if (Array.isArray(providerMappings)) {
    for (const mapping of providerMappings) {
      const domain = String(mapping?.provider_domain ?? '').toLowerCase();
      if (domain.includes('spotify')) {
        return AudioType.Spotify;
      }
      if (domain.includes('soundsuit')) {
        return AudioType.Radio;
      }
      if (domain.includes('airplay')) {
        return AudioType.AirPlay;
      }
      if (domain.includes('apple') || domain.includes('tidal') || domain.includes('deezer')) {
        return AudioType.File;
      }
    }
  }

  return AudioType.File;
}

/** Chooses the best cover art URL from the provided media/queue item. */
function mapCoverUrl(item: any): string {
  if (!item) return '';

  const direct = firstValidUrl(
    typeof item.image === 'string' ? item.image : undefined,
    item.image?.url,
    item.image?.path,
    item.image_url,
    item.cover,
  );
  if (direct) return direct;

  const metadataImage = extractImageFromMetadata(item.metadata);
  if (metadataImage) return metadataImage;

  const listImage = extractImageFromList(item.images);
  if (listImage) return listImage;

  return '';
}

/** Converts a queue entry into the simplified record used by the queue overlay. */
function mapQueueItem(item: any, fallbackDuration: number, index: number) {
  const media = item?.media_item ?? item ?? {};
  const audioType = determineAudioType(media, item);
  const rawPath = media.uri ?? '';
  const audiopath = normalizeMediaUri(rawPath);
  return {
    album: ensureString(media.album ?? ''),
    artist: mapArtists(media),
    audiopath,
    audiotype: audioType,
    coverurl: mapCoverUrl(media) || mapCoverUrl(item),
    duration: Number(media.duration ?? item?.duration ?? fallbackDuration ?? 0),
    qindex: index,
    station: '',
    title: media.title ?? media.name ?? item?.name ?? '',
    unique_id: item?.queue_item_id ?? '',
    user: '',
  };
}

/**
 * Applies Music Assistant queue updates to the structure expected by ZoneManager.
 */
export function mapQueueToState(
  loxoneZoneId: number,
  queue: any,
  cachedPrevious?: any,
): QueueMappingResult | undefined {
  if (!queue || !queue.current_item) {
    return undefined;
  } 

  const cur = queue.current_item;
  const mediaItem = cur.media_item ?? cur;

  const artist = mapArtists(mediaItem) || cur.artist || '';

  const repeat = (queue.repeat_mode ?? '').toString().toLowerCase();
  const repeatMode = repeat === 'one'
    ? RepeatMode.Track
    : repeat === 'all'
      ? RepeatMode.Queue
      : RepeatMode.NoRepeat;
  const shuffleEnabled = Boolean(queue.shuffle_enabled);

  const cover = mapCoverUrl(mediaItem) || mapCoverUrl(cur);
  const audioType = determineAudioType(mediaItem, cur);

  const trackUpdate: Partial<PlayerStatus> = {
    playerid: loxoneZoneId,
    title: mediaItem.title ?? mediaItem.name ?? cur.name ?? '',
    artist,
    album: ensureString(mediaItem.album ?? cur.album ?? ''),
    coverurl: cover,
    duration: Number(mediaItem.duration ?? cur.duration ?? 0),
    time: Number(queue.elapsed_time ?? 0),
    plrepeat: repeatMode,
    plshuffle: shuffleEnabled,
    clientState: 'on',
    type: FileType.Playlist,
    qid: cur.queue_item_id ?? '',
    qindex: 1,
    sourceName: 'Music Assistant',
    name: 'Music Assistant',
    audiopath: normalizeMediaUri(mediaItem.uri ?? ''),
    audiotype: audioType,
  };

  const cachedPrevCandidate = cachedPrevious?.queue_item_id === cur.queue_item_id ? undefined : cachedPrevious;

  const queueItemsRaw = Array.isArray(queue.items)
    ? queue.items.filter((item: any) => Boolean(item))
    : [];

  const items: QueueMappingResult['items'] = queueItemsRaw.length
    ? queueItemsRaw.map((item: any, index: number) => {
        const baseDuration = Number(item?.media_item?.duration ?? item?.duration ?? mediaItem.duration ?? 0);
        return mapQueueItem(item, baseDuration, index);
      })
    : (() => {
        const previousCandidates = [
          queue.previous_item,
          Array.isArray(queue.previous_items) ? queue.previous_items.slice(-1)[0] : undefined,
          Array.isArray(queue.history) ? queue.history.slice(-1)[0] : undefined,
          cachedPrevCandidate,
        ];
        const previous = previousCandidates.find(Boolean);
        const nextCandidates = [
          queue.next_item,
          Array.isArray(queue.next_items) ? queue.next_items[0] : undefined,
          Array.isArray(queue.items)
            ? queue.items.find((item: any) => item?.queue_item_id === queue.current_item?.queue_item_id)?.next
            : undefined,
        ];
        const next = nextCandidates.find(Boolean);

        const fallbackItems: QueueMappingResult['items'] = [];

        if (previous) {
          fallbackItems.push(
            mapQueueItem(previous, Number(previous?.duration ?? mediaItem.duration ?? 0), fallbackItems.length),
          );
        }

        fallbackItems.push(
          mapQueueItem(cur, Number(mediaItem.duration ?? 0), fallbackItems.length),
        );

        if (next) {
          fallbackItems.push(
            mapQueueItem(next, Number(next?.duration ?? 0), fallbackItems.length),
          );
        }

        return fallbackItems;
      })();

  const currentQueueItemId = cur.queue_item_id ?? '';
  let currentIndex = items.findIndex((item) => item.unique_id === currentQueueItemId);
  if (currentIndex < 0) {
    const fallbackIndex = queueItemsRaw.findIndex(
      (item: any) =>
        (item?.queue_item_id ?? item?.media_item?.queue_item_id ?? '') === currentQueueItemId,
    );
    currentIndex = fallbackIndex >= 0 ? fallbackIndex : 0;
  }

  return {
    trackUpdate: {
      ...trackUpdate,
      qindex: currentIndex >= 0 ? currentIndex : 0,
    },
    items,
    shuffleEnabled,
  };
}
