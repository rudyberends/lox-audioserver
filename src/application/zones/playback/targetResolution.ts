import { normalizeSpotifyAudiopath } from '@/application/zones/helpers/queueHelpers';

export function isSameAudiopath(
  current: string | null | undefined,
  target: string | null | undefined,
): boolean {
  if (!current || !target) {
    return false;
  }
  return normalizeSpotifyAudiopath(current) === normalizeSpotifyAudiopath(target);
}
