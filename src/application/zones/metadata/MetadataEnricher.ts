import type { PlaybackMetadata } from '@/application/playback/audioManager';
import type { ContentPort } from '@/ports/ContentPort';
import type { ContentItemMetadata } from '@/ports/ContentTypes';
import type { ParentContext } from '@/application/zones/policies/ParentContextPolicy';

export async function enrichMetadata(args: {
  content: ContentPort;
  uri: string;
  queueAudiopath: string;
  parentContext: ParentContext | null;
  isRadio: boolean;
  isMusicAssistant: boolean;
  isAppleMusic: boolean;
  stationValue: string;
  incoming?: PlaybackMetadata;
}): Promise<PlaybackMetadata | undefined> {
  const {
    content,
    queueAudiopath,
    parentContext,
    isRadio,
    isMusicAssistant,
    isAppleMusic,
    stationValue,
    incoming,
  } = args;
  let enrichedMetadata: PlaybackMetadata | undefined =
    parentContext?.parent || incoming
      ? {
        ...(incoming ?? { title: '', artist: '', album: '' }),
        station: stationValue ?? (incoming as { station?: string } | undefined)?.station,
      }
      : incoming;

  const mergeMetadata = (
    base: PlaybackMetadata | undefined,
    incomingMeta: ContentItemMetadata | null,
  ): PlaybackMetadata | undefined => {
    if (!incomingMeta) {
      return base;
    }
    const merged: PlaybackMetadata = {
      title: '',
      artist: '',
      album: '',
      ...(base ?? {}),
    };
    const assignText = (key: 'title' | 'artist' | 'album' | 'coverurl') => {
      const current = typeof merged[key] === 'string' ? merged[key].trim() : '';
      const isPlaceholder = key === 'title' && current === 'Loading…';
      const candidate = typeof incomingMeta[key] === 'string' ? incomingMeta[key].trim() : '';
      if ((!current || isPlaceholder) && candidate) {
        merged[key] = candidate;
      }
    };
    assignText('title');
    assignText('artist');
    assignText('album');
    assignText('coverurl');
    if (!merged.animatedCoverUrl && incomingMeta.animatedCoverUrl) {
      merged.animatedCoverUrl = incomingMeta.animatedCoverUrl;
    }
    if ((!merged.station || !merged.station.trim()) && incomingMeta.station?.trim()) {
      merged.station = incomingMeta.station.trim();
    }
    if (typeof incomingMeta.duration === 'number' && incomingMeta.duration > 0) {
      const current = typeof merged.duration === 'number' ? merged.duration : 0;
      if (!current || current <= 0) {
        merged.duration = incomingMeta.duration;
      }
    }
    if (stationValue && (!merged.station || !merged.station.trim())) {
      merged.station = stationValue;
    }
    return merged;
  };

  // Radio has no duration to resolve, but it still needs station metadata such as cover art.
  // Resolve it when the request did not already carry artwork; TuneIn/custom streams are
  // resolved by URL in ContentManager and return the now-playing-sized cover.
  const shouldResolveMetadata =
    (isRadio && !enrichedMetadata?.coverurl) ||
    (!isRadio &&
      (!enrichedMetadata?.duration ||
        ((isMusicAssistant || isAppleMusic) &&
          (!enrichedMetadata ||
            !enrichedMetadata.title ||
            !enrichedMetadata.artist ||
            (isAppleMusic && !enrichedMetadata.animatedCoverUrl)))));

  if (shouldResolveMetadata) {
    try {
      const metaTarget = parentContext?.startItem ?? queueAudiopath;
      const meta = await content.resolveMetadata(metaTarget);
      if (meta) {
        enrichedMetadata = mergeMetadata(enrichedMetadata, meta);
      }
    } catch {
      /* ignore */
    }
  }

  return enrichedMetadata;
}
