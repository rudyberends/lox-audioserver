import type { InputStartDecision } from '@/application/zones/playback/types';

export function resolveAirplayInputStart(): InputStartDecision {
  return { mode: 'airplay', queueAuthority: 'airplay' };
}
