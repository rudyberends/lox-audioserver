import { Track } from '../zonemanager';

interface QueueMappingResult {
  trackUpdate: Partial<Track>;
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
  shuffleEnabled: number;
}

export function mapPlayerToTrack(loxoneZoneId: number, player: any): Partial<Track> {
  const isPlaying = player.state === 'playing';

  return {
    playerid: loxoneZoneId,
    mode: isPlaying ? 'play' : 'pause',
    power: 'on',
    volume: Number(player.volume_level ?? 0),
  };
}

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

function firstValidUrl(...candidates: Array<string | undefined | null>): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return '';
}

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

function determineAudioType(media: any, fallback: any): number {
  const uri: string = ensureString(media?.uri ?? fallback?.uri ?? '');
  if (uri.startsWith('library://')) {
    return 2; // Local library / external source
  }
  if (uri.startsWith('spotify:') || uri.startsWith('apple_music://') || uri.startsWith('tidal://')) {
    return 5; // Streaming service
  }

  const providerMappings = media?.provider_mappings;
  if (Array.isArray(providerMappings)) {
    for (const mapping of providerMappings) {
      const domain = String(mapping?.provider_domain ?? '').toLowerCase();
      if (domain.includes('spotify') || domain.includes('apple') || domain.includes('tidal')) {
        return 5;
      }
    }
  }

  return 2;
}

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

function mapQueueItem(item: any, fallbackDuration: number, index: number) {
  const media = item?.media_item ?? item ?? {};
  const audioType = determineAudioType(media, item);
  return {
    album: ensureString(media.album ?? ''),
    artist: mapArtists(media),
    audiopath: media.uri ?? '',
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
  const repeatNum = repeat === 'one' ? 1 : repeat === 'all' ? 2 : 0;
  const shuffleEnabled = Number(Boolean(queue.shuffle_enabled));

  const cover = mapCoverUrl(mediaItem) || mapCoverUrl(cur);
  const audioType = determineAudioType(mediaItem, cur);

  const trackUpdate: Partial<Track> = {
    playerid: loxoneZoneId,
    title: mediaItem.title ?? mediaItem.name ?? cur.name ?? '',
    artist,
    album: ensureString(mediaItem.album ?? cur.album ?? ''),
    coverurl: cover,
    duration: Number(mediaItem.duration ?? cur.duration ?? 0),
    time: Number(queue.elapsed_time ?? 0),
    plrepeat: repeatNum,
    plshuffle: shuffleEnabled,
    clientState: 'on',
    type: 3,
    qid: cur.queue_item_id ?? '',
    qindex: 1,
    sourceName: 'Music Assistant',
    name: 'Music Assistant',
    audiopath: mediaItem.uri ?? '',
    audiotype: audioType,
  };

  const cachedPrevCandidate = cachedPrevious?.queue_item_id === cur.queue_item_id ? undefined : cachedPrevious;

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

  const items = [] as QueueMappingResult['items'];

  if (previous) {
    items.push(mapQueueItem(previous, Number(previous?.duration ?? mediaItem.duration ?? 0), 0));
  }

  items.push(mapQueueItem(cur, Number(mediaItem.duration ?? 0), 1));

  if (next) {
    items.push(mapQueueItem(next, Number(next?.duration ?? 0), 2));
  }

  return {
    trackUpdate,
    items,
    shuffleEnabled,
  };
}
