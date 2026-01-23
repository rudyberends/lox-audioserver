import type { InputStartDecision } from '@/application/zones/playback/types';

export function resolveSpotifyInputStart(): InputStartDecision {
  return { mode: 'spotify', queueAuthority: 'spotify' };
}
