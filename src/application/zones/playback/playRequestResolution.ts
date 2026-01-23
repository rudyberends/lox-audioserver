import type { PlaybackMetadata } from '@/application/playback/audioManager';
import type { ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';
import type { ParentContext } from '@/application/zones/policies/ParentContextPolicy';
import type { ResolvedPlayRequest } from '@/application/zones/playback/types';

export type ResolvePlayRequestDeps = {
  audioHelpers: ZoneAudioHelpers;
  parseParentContext: (uri: string, opts?: {
    isAppleMusicProvider: (providerId: string) => boolean;
    isDeezerProvider: (providerId: string) => boolean;
    isTidalProvider: (providerId: string) => boolean;
  }) => ParentContext | null;
  classifyIsRadio: (args: {
    uri: string;
    resolvedTarget: string;
    metadata?: PlaybackMetadata;
  }) => boolean;
  decodeAudiopath: (path: string) => string;
  encodeAudiopath: (originalUri: string, itemType?: string, providerPrefix?: string, useBase64?: boolean) => string;
  normalizeSpotifyAudiopath: (path: string) => string;
  sanitizeStation: (station: string, target: string) => string;
  isAppleMusicProvider: (providerId: string) => boolean;
  isDeezerProvider: (providerId: string) => boolean;
  isTidalProvider: (providerId: string) => boolean;
  getMusicAssistantProviderId: () => string;
};

export function resolvePlayRequest(args: {
  uri: string;
  type: string;
  metadata?: PlaybackMetadata;
  deps: ResolvePlayRequestDeps;
}): ResolvedPlayRequest {
  const { uri, type, metadata, deps } = args;
  const {
    audioHelpers,
    parseParentContext,
    classifyIsRadio,
    decodeAudiopath,
    encodeAudiopath,
    normalizeSpotifyAudiopath,
    sanitizeStation,
    isAppleMusicProvider,
    isDeezerProvider,
    isTidalProvider,
  } = deps;

  const parentContext = parseParentContext(uri, {
    isAppleMusicProvider,
    isDeezerProvider,
    isTidalProvider,
  });
  const isAppleMusicUri = audioHelpers.isAppleMusicAudiopath(uri);
  const isDeezerUri = audioHelpers.isDeezerAudiopath(uri);
  const isTidalUri = audioHelpers.isTidalAudiopath(uri);
  let resolvedTarget =
    parentContext?.parent ??
    (isAppleMusicUri || isDeezerUri || isTidalUri ? uri : decodeAudiopath(uri));
  let stationUri = parentContext?.parent ? normalizeSpotifyAudiopath(parentContext.parent) : '';
  let normalizedTarget = normalizeSpotifyAudiopath(resolvedTarget);
  const isMusicAssistantInitial = audioHelpers.isMusicAssistantAudiopath(uri) ||
    audioHelpers.isMusicAssistantAudiopath(resolvedTarget);
  let queueAudiopath = isMusicAssistantInitial ? normalizeSpotifyAudiopath(uri) : normalizedTarget;
  if (isMusicAssistantInitial && parentContext?.parent) {
    const providerPrefix = queueAudiopath.split(':')[0] || deps.getMusicAssistantProviderId();
    const parentType = /playlist/i.test(parentContext.parent)
      ? 'playlist'
      : /album/i.test(parentContext.parent)
        ? 'album'
        : /artist/i.test(parentContext.parent)
          ? 'artist'
          : 'track';
    const wrappedParent = encodeAudiopath(parentContext.parent, parentType, providerPrefix);
    resolvedTarget = wrappedParent;
    normalizedTarget = normalizeSpotifyAudiopath(resolvedTarget);
    stationUri = normalizeSpotifyAudiopath(resolvedTarget);
    queueAudiopath = normalizeSpotifyAudiopath(uri);
  }
  const isMusicAssistant = audioHelpers.isMusicAssistantAudiopath(queueAudiopath) ||
    audioHelpers.isMusicAssistantAudiopath(resolvedTarget);
  const isAppleMusic = audioHelpers.isAppleMusicAudiopath(queueAudiopath) ||
    audioHelpers.isAppleMusicAudiopath(resolvedTarget);
  const isDeezer = audioHelpers.isDeezerAudiopath(queueAudiopath) ||
    audioHelpers.isDeezerAudiopath(resolvedTarget);
  const isTidal = audioHelpers.isTidalAudiopath(queueAudiopath) ||
    audioHelpers.isTidalAudiopath(resolvedTarget);
  const isSpotify = audioHelpers.isSpotifyAudiopath(queueAudiopath);
  const nextInput = isSpotify
    ? 'spotify'
    : isMusicAssistant
      ? 'musicassistant'
      : 'queue';

  let stationValue =
    parentContext?.parent && isMusicAssistant
      ? parentContext.parent
      : parentContext?.parent
        ? sanitizeStation(parentContext.parent, normalizedTarget)
        : stationUri;
  const isRadio = classifyIsRadio({ uri, resolvedTarget, metadata });
  if (isRadio && !stationValue && metadata?.station?.trim()) {
    stationValue = metadata.station.trim();
  }
  if (isRadio && !stationValue && metadata?.title?.trim()) {
    stationValue = metadata.title.trim();
  }
  if (isRadio && !stationValue) {
    stationValue =
      audioHelpers.deriveRadioStationLabel(resolvedTarget) ??
      audioHelpers.deriveRadioStationLabel(uri) ??
      '';
  }

  const queueSourcePath = isAppleMusic && parentContext?.parent ? parentContext.parent : uri;
  const targetForQueueBuild = normalizeSpotifyAudiopath(resolvedTarget || '');
  const shouldLimitQueueBuild = Boolean(
    targetForQueueBuild && /(library-)?(album|playlist|artist):/i.test(targetForQueueBuild),
  );
  const queueBuildLimit = shouldLimitQueueBuild ? 50 : undefined;
  const isLineIn = type === 'linein';

  return {
    uri,
    type,
    metadata,
    parentContext,
    hasParentContext: Boolean(parentContext),
    resolvedTarget,
    normalizedTarget,
    stationUri,
    queueAudiopath,
    isMusicAssistantInitial,
    isMusicAssistant,
    isAppleMusic,
    isDeezer,
    isTidal,
    isSpotify,
    nextInput,
    stationValue,
    isRadio,
    queueSourcePath,
    targetForQueueBuild,
    shouldLimitQueueBuild,
    queueBuildLimit,
    isLineIn,
    isAppleMusicUri,
    isDeezerUri,
    isTidalUri,
  };
}
