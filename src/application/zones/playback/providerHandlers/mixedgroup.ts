import type { InputStartDecision } from '@/application/zones/playback/types';

export function resolveMixedGroupInputStart(): InputStartDecision {
  return { mode: 'mixedgroup', queueAuthority: 'local' };
}
