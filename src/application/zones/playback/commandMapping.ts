import type { InputStartDecision } from '@/application/zones/playback/types';
import { resolveAirplayInputStart } from '@/application/zones/playback/providerHandlers/airplay';
import { resolveSpotifyInputStart } from '@/application/zones/playback/providerHandlers/spotify';
import { resolveMusicAssistantInputStart } from '@/application/zones/playback/providerHandlers/musicAssistant';
import { resolveLineInInputStart } from '@/application/zones/playback/providerHandlers/linein';
import { resolveMixedGroupInputStart } from '@/application/zones/playback/providerHandlers/mixedgroup';

export function resolveInputStartDecision(label: string): InputStartDecision | null {
  const normalized = label.toLowerCase();
  switch (normalized) {
    case 'airplay':
      return resolveAirplayInputStart();
    case 'spotify':
      return resolveSpotifyInputStart();
    case 'musicassistant':
      return resolveMusicAssistantInputStart();
    case 'linein':
      return resolveLineInInputStart();
    case 'mixedgroup':
      return resolveMixedGroupInputStart();
    default:
      return null;
  }
}
