import type { ZoneAudioPreferences } from '@/application/playback/ZoneAudioPreferences';
import type { PreferredPlaybackSettings } from '@/application/playback/policies/OutputFormatPolicy';

export function applyPreferredPlaybackSettings(
  prefs: ZoneAudioPreferences,
  zoneId: number,
  settings: PreferredPlaybackSettings,
): void {
  prefs.setPreferredOutputSettings(zoneId, settings.outputOverride);
  if (Object.prototype.hasOwnProperty.call(settings, 'httpPrefs')) {
    prefs.setHttpPreferences(zoneId, settings.httpPrefs ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'inputPrefs')) {
    prefs.setInputPreferences(zoneId, settings.inputPrefs ?? null);
  }
}
