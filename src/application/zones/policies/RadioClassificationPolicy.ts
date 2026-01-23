import type { PlaybackMetadata } from '@/application/playback/audioManager';
import { decodeAudiopath } from '@/domain/loxone/audiopath';
import { isRadioAudiopath } from '@/application/zones/internal/zoneAudioHelpers';

export function classifyIsRadio(args: {
  uri: string;
  resolvedTarget: string;
  metadata?: PlaybackMetadata;
}): boolean {
  const { uri, resolvedTarget, metadata } = args;
  let isRadio = isRadioAudiopath(resolvedTarget) || isRadioAudiopath(uri);
  if (!isRadio) {
    const decodedTarget = decodeAudiopath(resolvedTarget) || resolvedTarget;
    const decodedUri = decodeAudiopath(uri) || uri;
    const isHttpStream =
      /^https?:\/\//i.test(decodedTarget) || /^https?:\/\//i.test(decodedUri);
    if (isHttpStream && !(metadata?.duration && metadata.duration > 0)) {
      isRadio = true;
    }
  }
  return isRadio;
}
