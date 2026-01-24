import type { AudioManager } from '@/application/playback/audioManager';
import type { PreferredPlaybackSettings } from '@/application/playback/policies/OutputFormatPolicy';

export function applyPreferredPlaybackSettings(
  audioManager: AudioManager,
  zoneId: number,
  settings: PreferredPlaybackSettings,
): void {
  audioManager.setPreferredOutputSettings(zoneId, settings.outputOverride);
  if (Object.prototype.hasOwnProperty.call(settings, 'httpPrefs')) {
    audioManager.setHttpPreferences(zoneId, settings.httpPrefs ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'inputPrefs')) {
    audioManager.setInputPreferences(zoneId, settings.inputPrefs ?? null);
  }
}
