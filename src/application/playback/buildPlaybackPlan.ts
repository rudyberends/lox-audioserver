import type { PlaybackMetadata } from '@/application/playback/audioManager';
import type { ZoneContext } from '@/application/zones/internal/zoneTypes';
import type { PreferredPlaybackSettings } from '@/application/playback/policies/OutputFormatPolicy';
import { detectServiceFromAudiopath } from '@/domain/loxone/audiopath';
import type { PlaybackPlan, ProviderKind } from '@/application/playback/types/PlaybackPlan';

type PlaybackClassification = {
  isSpotify: boolean;
  isMusicAssistant: boolean;
  provider: ProviderKind;
};

export type BuildPlaybackPlanArgs = {
  ctx: ZoneContext;
  audiopath: string;
  metadata: PlaybackMetadata;
  isRadio: boolean;
  preferredSettings: PreferredPlaybackSettings;
  classification?: PlaybackClassification;
};

const mapProvider = (service: string): ProviderKind => {
  if (service === 'applemusic') {
    return 'applemusic';
  }
  if (service === 'deezer') {
    return 'deezer';
  }
  if (service === 'tidal') {
    return 'tidal';
  }
  return null;
};

export function buildPlaybackPlan(args: BuildPlaybackPlanArgs): PlaybackPlan {
  const detected = detectServiceFromAudiopath(args.audiopath);
  const provider = args.classification?.provider ?? mapProvider(detected);
  const isMusicAssistant = args.classification?.isMusicAssistant ?? detected === 'musicassistant';
  const isSpotify = args.classification?.isSpotify ?? detected === 'spotify';
  const playExternalLabel = isSpotify
    ? 'spotify'
    : isMusicAssistant
      ? 'musicassistant'
      : provider
        ? provider
        : null;
  const needsStreamResolution = Boolean(isSpotify || isMusicAssistant || provider);
  const kind = provider ? 'provider-stream' : 'queue';
  const metadata =
    provider || isMusicAssistant
      ? ({ ...args.metadata, audiotype: 5 } as PlaybackMetadata)
      : args.metadata;

  return {
    zoneId: args.ctx.id,
    zoneName: args.ctx.name,
    audiopath: args.audiopath,
    kind,
    isRadio: args.isRadio,
    provider,
    playExternalLabel,
    needsStreamResolution,
    metadata,
    preferredSettings: args.preferredSettings,
  };
}
