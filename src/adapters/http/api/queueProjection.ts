/**
 * Projects a zone's stored queue onto the public API contract.
 *
 * Reads the raw queue rather than the Loxone-facing one: that path collapses every
 * service-native audiopath to `spotify:<kind>:<id>`, because the native client's queue
 * schema refuses anything else. A neutral consumer needs the real ids.
 */
import type { ApiQueue, ApiQueueItem } from '@/domain/zones/apiTypes';
import type { QueueItem } from '@/ports/types/queueTypes';

function toItem(item: QueueItem): ApiQueueItem {
  return {
    // `unique_id` identifies this entry, not the track — queue the same track twice
    // and you get two handles, which is what move and remove need.
    id: item.unique_id,
    title: item.title ?? '',
    artist: item.artist ?? '',
    album: item.album ?? '',
    duration: Number.isFinite(item.duration) ? Math.max(0, Math.round(item.duration)) : 0,
    coverUrl: item.coverurl ?? '',
    ...(item.animatedCoverUrl ? { animatedCoverUrl: item.animatedCoverUrl } : {}),
    source: item.audiopath ?? '',
  };
}

export function toApiQueue(
  zoneId: number,
  raw: { items: QueueItem[]; start: number; total: number; currentIndex: number | null },
): ApiQueue {
  return {
    zoneId,
    items: raw.items.map(toItem),
    start: raw.start,
    total: raw.total,
    currentIndex: raw.currentIndex,
  };
}
