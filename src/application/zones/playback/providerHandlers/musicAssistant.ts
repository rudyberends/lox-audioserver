import type { InputStartDecision } from '@/application/zones/playback/types';

export function resolveMusicAssistantInputStart(): InputStartDecision {
  return { mode: 'musicassistant', queueAuthority: 'musicassistant' };
}
