import type { InputStartDecision } from '@/application/zones/playback/types';

export function resolveLineInInputStart(): InputStartDecision {
  return { mode: 'linein', queueAuthority: 'local' };
}
