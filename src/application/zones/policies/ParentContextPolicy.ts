import { decodeAudiopath } from '@/domain/loxone/audiopath';
import { normalizeSpotifyAudiopath } from '@/application/zones/helpers/queueHelpers';

export type ParentContext = {
  parent: string;
  startItem?: string;
  startIndex?: number;
};

type ProviderChecks = {
  isAppleMusicProvider?: (providerId: string) => boolean;
  isDeezerProvider?: (providerId: string) => boolean;
  isTidalProvider?: (providerId: string) => boolean;
};

export function parseParentContext(raw: string): ParentContext | null;
export function parseParentContext(raw: string, providers?: ProviderChecks): ParentContext | null;
export function parseParentContext(raw: string, providers?: ProviderChecks): ParentContext | null {
  const sep = '/parentpath/';
  if (!raw.includes(sep)) {
    return null;
  }
  const idx = raw.indexOf(sep);
  const childRaw = raw.slice(0, idx);
  const parentAndRest = raw
    .slice(idx + sep.length)
    .replace(/\/noshuffle.*$/i, '')
    .replace(/\/\?q&ZW5mb3JjZVVzZXI9dHJ1ZQ.*$/i, '')
    .replace(/\/\?q&[A-Za-z0-9+/=]+$/i, '')
    .replace(/\/+$/, '');
  const lastSlash = parentAndRest.lastIndexOf('/');
  const parentRaw = lastSlash >= 0 ? parentAndRest.slice(0, lastSlash) : parentAndRest;
  const indexPart = lastSlash >= 0 ? parentAndRest.slice(lastSlash + 1) : '';

  const startIndex =
    indexPart && /^\d+$/.test(indexPart) ? Number(indexPart) : undefined;

  const parentProvider = parentRaw.split(':')[0] ?? '';
  const isAppleMusicParent =
    Boolean(parentProvider && providers?.isAppleMusicProvider?.(parentProvider)) ||
    /applemusic/i.test(parentRaw);
  const isDeezerParent =
    Boolean(parentProvider && providers?.isDeezerProvider?.(parentProvider)) ||
    /deezer/i.test(parentRaw);
  const isTidalParent =
    Boolean(parentProvider && providers?.isTidalProvider?.(parentProvider)) ||
    /tidal/i.test(parentRaw);
  return {
    parent: (isAppleMusicParent || isDeezerParent || isTidalParent)
      ? normalizeSpotifyAudiopath(parentRaw)
      : decodeAudiopath(parentRaw),
    // Keep the original provider wrapper (e.g., spotify@bridge:track:...) for the item so routing stays intact.
    startItem: normalizeSpotifyAudiopath(childRaw),
    startIndex,
  };
}
