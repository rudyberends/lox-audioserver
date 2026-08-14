import { normalizeSpotifyAudiopath } from '@/application/zones/helpers/queueHelpers';
import type { QueueAuthority } from '@/application/zones/internal/zoneTypes';
import type { QueueItem } from '@/ports/types/queueTypes';

export function findQueueIndexByUri(items: QueueItem[], uri: string | undefined): number {
  if (!uri) {
    return -1;
  }
  const normalizedUri = normalizeSpotifyAudiopath(uri);
  return items.findIndex(
    (item) => normalizeSpotifyAudiopath(item.audiopath) === normalizedUri,
  );
}

/**
 * Which side owns the queue for a play request. Spotify is absent on purpose: it
 * plays through our own Connect host, so we drive its queue like any local one.
 */
export function resolveQueueAuthority(args: {
  isMusicAssistant: boolean;
  isAppleMusic: boolean;
  isDeezer: boolean;
  isTidal: boolean;
  isSoundcloud: boolean;
}): QueueAuthority {
  const forceLocalQueue =
    args.isAppleMusic || args.isDeezer || args.isTidal || args.isSoundcloud;
  if (forceLocalQueue) {
    return 'local';
  }
  if (args.isMusicAssistant) {
    return 'musicassistant';
  }
  return 'local';
}
