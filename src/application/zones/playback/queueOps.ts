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

export function resolveQueueAuthority(args: {
  isMusicAssistant: boolean;
  isAppleMusic: boolean;
  isDeezer: boolean;
  isTidal: boolean;
  isSpotify: boolean;
  bridgeProvider: string | null;
}): QueueAuthority {
  const forceLocalQueue =
    args.isAppleMusic ||
    (args.isSpotify && Boolean(args.bridgeProvider && args.bridgeProvider !== 'spotify'));
  if (forceLocalQueue) {
    return 'local';
  }
  if (args.isMusicAssistant) {
    return 'musicassistant';
  }
  if (args.isAppleMusic) {
    return 'applemusic';
  }
  if (args.isDeezer) {
    return 'deezer';
  }
  if (args.isTidal) {
    return 'tidal';
  }
  if (args.isSpotify) {
    return 'spotify';
  }
  return 'local';
}
