import type { QueueItem } from '@/ports/types/queueTypes';
import { createQueueItem } from '@/application/zones/helpers/queueHelpers';
import { encodeAudiopath } from '@/domain/zones/audiopath';
import { extractCoverUrl, pickNumber, pickRecord, pickString } from './maHelpers';
import { COVER_ART_BROWSE_SIZE } from '@/shared/coverArt';

/**
 * Map a list of MA queue items into our own QueueItem shape. MA queue items
 * carry their own `media_item` with title/artist/duration/image; we project
 * those onto the fields Loxone expects, encoding the URI as audiopath.
 */
export function mapMaItemsToQueue(
  items: unknown[],
  providerPrefix: string,
  zoneName: string,
): QueueItem[] {
  if (!Array.isArray(items)) return [];
  const out: QueueItem[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const raw = items[i];
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const media = pickRecord(r.media_item) ?? r;
    const title = pickString(r.name) ?? pickString(media.name) ?? pickString(media.title) ?? '';
    const artist =
      pickString(media.artist) ?? pickString(media.artists) ?? pickString(media.album_artist) ?? '';
    const album = pickString(media.album) ?? '';
    const cover = extractCoverUrl(media as Record<string, unknown>, COVER_ART_BROWSE_SIZE);
    const durationRaw = pickNumber(r.duration) ?? pickNumber(media.duration);
    const rawUri =
      pickString(r.uri) ??
      pickString(media.uri) ??
      pickString(r.queue_item_id) ??
      pickString(r.item_id) ??
      '';
    if (!rawUri) continue;
    const mediaType = (pickString(media.media_type) ?? '').toLowerCase();
    const itemType = mediaType.includes('radio')
      ? 'radio'
      : mediaType.includes('playlist')
        ? 'playlist'
        : 'track';
    const audiopath = encodeAudiopath(rawUri, itemType, providerPrefix, true);
    const item = createQueueItem(audiopath, zoneName, {
      title,
      artist,
      album,
      coverurl: cover,
      duration: durationRaw !== null ? Math.max(0, Math.round(durationRaw)) : 0,
      unique_id: pickString(r.queue_item_id) ?? pickString(r.item_id) ?? undefined,
    } as unknown as Parameters<typeof createQueueItem>[2]);
    item.qindex = i;
    out.push(item);
  }
  return out;
}
