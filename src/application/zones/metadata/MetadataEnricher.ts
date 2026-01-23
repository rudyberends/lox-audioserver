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
        station: stationValue ?? (incoming as any)?.station,
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
      const candidate = typeof incomingMeta[key] === 'string' ? incomingMeta[key].trim() : '';
      if (!current && candidate) {
        merged[key] = candidate as any;
      }
    };
    assignText('title');
    assignText('artist');
    assignText('album');
    assignText('coverurl');
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

  const shouldResolveMetadata =
    !isRadio &&
    (!enrichedMetadata?.duration ||
      ((isMusicAssistant || isAppleMusic) &&
        (!enrichedMetadata || !enrichedMetadata.title || !enrichedMetadata.artist)));

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
