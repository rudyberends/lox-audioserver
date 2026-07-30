import type { PlaybackMetadata } from '@/application/playback/audioManager';

type QueueItemMetadata = {
  title?: string;
  artist?: string;
  album?: string;
  coverurl?: string;
  animatedCoverUrl?: string;
  duration?: number;
};

export type SelectedNowPlayingMetadata = {
  title: string;
  artist: string;
  album: string;
  coverurl?: string;
  animatedCoverUrl?: string;
  duration?: number;
};

/**
 * Chooses the now-playing display metadata for the queue item being started.
 *
 * The now-playing must describe `current` (the actual track), so its own
 * metadata is preferred and the enriched/seed metadata only fills gaps. Without
 * this, a container play — e.g. an artist favourite whose play request is seeded
 * with the artist name — would show the container instead of the track, because
 * the enricher only fills empty fields and so keeps the seed title.
 *
 * Two exceptions, expressed via `itemFirst = false`:
 * - Radio items carry empty titles (metadata arrives later via ICY), so they
 *   naturally fall through to the enriched (station-resolved) values even when
 *   item-first; callers keep them item-first.
 * - YouTube/ytmusic queue items can still read "Loading…", so callers pass
 *   `itemFirst = false` to keep the enriched value ahead of the placeholder.
 */
export function selectQueuePlaybackMetadata(
  current: QueueItemMetadata,
  enriched: PlaybackMetadata | undefined,
  opts: { itemFirst: boolean; fallbackTitle: string },
): SelectedNowPlayingMetadata {
  const { itemFirst, fallbackTitle } = opts;
  const pick = (itemValue?: string, enrichedValue?: string): string => {
    const item = itemValue?.trim() ?? '';
    const enrichedText = enrichedValue?.trim() ?? '';
    return itemFirst ? item || enrichedText : enrichedText || item;
  };
  return {
    title: pick(current.title, enriched?.title) || fallbackTitle,
    artist: pick(current.artist, enriched?.artist),
    album: pick(current.album, enriched?.album),
    coverurl: itemFirst
      ? current.coverurl || enriched?.coverurl
      : enriched?.coverurl || current.coverurl,
    animatedCoverUrl: current.animatedCoverUrl || enriched?.animatedCoverUrl,
    duration:
      itemFirst && typeof current.duration === 'number' && current.duration > 0
        ? current.duration
        : typeof enriched?.duration === 'number'
          ? enriched.duration
          : current.duration,
  };
}
