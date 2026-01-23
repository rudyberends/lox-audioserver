import type { PlaybackMetadata } from '@/application/playback/audioManager';
import type { QueueItem } from '@/ports/types/queueTypes';

const trimValue = (value?: string): string => (typeof value === 'string' ? value.trim() : '');

export function computeQueueItemMetadataUpdate(
  current: QueueItem,
  metadata: Partial<PlaybackMetadata>,
): { changed: boolean; updates: Partial<QueueItem> } {
  let changed = false;
  const updates: Partial<QueueItem> = {};
  const assign = (
    key: 'title' | 'artist' | 'album' | 'coverurl' | 'audiopath',
    value?: string,
  ): void => {
    const trimmed = trimValue(value);
    if (trimmed && current[key] !== trimmed) {
      updates[key] = trimmed;
      changed = true;
    }
  };

  assign('title', metadata.title);
  assign('artist', metadata.artist);
  assign('album', metadata.album);
  assign('coverurl', metadata.coverurl as string | undefined);
  assign('audiopath', metadata.audiopath);

  return { changed, updates };
}
