import type { ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import { AudioType, FileType } from '@/domain/loxone/enums';
import { fallbackTitle, sanitizeTitle } from '@/application/zones/helpers/stateHelpers';
import type { ProviderAction, ProviderPatchResult } from '@/application/zones/playback/types';

export function handleRadioMetadataUpdate(args: {
  state: LoxoneZoneState;
  zoneName: string;
  metadata: { title: string; artist: string; coverurl?: string; duration?: number; controllable?: boolean };
  audioHelpers: ZoneAudioHelpers;
  radioStationFallback?: string | null;
  radioControllable?: boolean;
}): ProviderPatchResult | null {
  const { state, zoneName, metadata, audioHelpers, radioStationFallback, radioControllable } = args;
  if (state.mode !== 'play') {
    return null;
  }
  const isRadioState = audioHelpers.isRadioAudiopath(state.audiopath, state.audiotype);
  if (!isRadioState && !radioControllable) {
    return null;
  }
  const patch: Partial<LoxoneZoneState> = {};
  if (metadata.title) {
    patch.title = sanitizeTitle(metadata.title, fallbackTitle(state.title, zoneName));
  }
  if (metadata.coverurl) {
    patch.coverurl = metadata.coverurl;
  }
  if (metadata.controllable === true) {
    patch.audiotype = AudioType.File;
    patch.type = FileType.File;
  }
  if (typeof metadata.duration === 'number' && metadata.duration > 0) {
    patch.duration = Math.round(metadata.duration);
  } else if (metadata.controllable === true || radioControllable) {
    // For controllable radio sources (Radio Paradise), duration may be unavailable.
    // Explicitly clear duration so we don't keep the previous track's duration.
    patch.duration = 0;
  }
  const artist = metadata.artist ?? '';
  patch.artist = artist;
  const actions: ProviderAction[] = [];
  if (typeof metadata.controllable === 'boolean') {
    actions.push({ type: 'setRadioControllable', value: metadata.controllable });
  }
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
