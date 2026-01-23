import type { ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import { fallbackTitle, sanitizeTitle } from '@/application/zones/helpers/stateHelpers';
import type { ProviderAction, ProviderPatchResult } from '@/application/zones/playback/types';

export function handleRadioMetadataUpdate(args: {
  state: LoxoneZoneState;
  zoneName: string;
  metadata: { title: string; artist: string };
  audioHelpers: ZoneAudioHelpers;
  radioStationFallback?: string | null;
}): ProviderPatchResult | null {
  const { state, zoneName, metadata, audioHelpers, radioStationFallback } = args;
  if (state.mode !== 'play' || !audioHelpers.isRadioAudiopath(state.audiopath, state.audiotype)) {
    return null;
  }
  const patch: Partial<LoxoneZoneState> = {};
  if (metadata.title) {
    patch.title = sanitizeTitle(metadata.title, fallbackTitle(state.title, zoneName));
  }
  const artist = metadata.artist ?? '';
  patch.artist = artist;
  const actions: ProviderAction[] = [];
  if (artist.trim()) {
    if (state.station) {
      patch.station = state.station;
      actions.push({ type: 'setRadioStationFallback', value: state.station });
    }
  } else if (!state.station) {
    const fallback = typeof radioStationFallback === 'string' ? radioStationFallback : '';
    if (fallback) {
      patch.station = fallback;
    }
  }
  if (Object.keys(patch).length === 0) {
    return null;
  }
  return { patch, actions: actions.length ? actions : undefined };
}
