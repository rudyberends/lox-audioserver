import type { QueueItem } from '@/ports/types/queueTypes';
import type { SpotifyQueueTrack } from '@/ports/InputsPort';
import { createQueueItem } from '@/application/zones/helpers/queueHelpers';

/**
 * Turn the Spotify app's queue into this server's own.
 *
 * The tracks arrive as plain facts from the input adapter — it has no business knowing what a
 * `QueueItem` wants — so everything the queue needs beyond a title is derived here. Spotify's own
 * entry handle becomes `unique_id`, which matters because a queue may hold the same track twice
 * and the two rows have to stay apart.
 */
export function mapSpotifyTracksToQueue(
  tracks: SpotifyQueueTrack[],
  zoneName: string,
): QueueItem[] {
  const items: QueueItem[] = [];
  for (const track of tracks) {
    if (!track?.uri) {
      continue;
    }
    const item = createQueueItem(track.uri, zoneName, {
      title: track.title ?? '',
      artist: track.artist ?? '',
      album: track.album ?? '',
      coverurl: track.coverUrl ?? '',
      duration: track.durationSec,
      ...(track.uid ? { unique_id: track.uid } : {}),
    } as Parameters<typeof createQueueItem>[2]);
    item.qindex = items.length;
    items.push(item);
  }
  return items;
}
