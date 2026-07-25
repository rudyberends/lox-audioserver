import type { InputStartDecision } from '@/application/zones/playback/types';

/**
 * A DLNA renderer input (an external control point casting a URL to the zone).
 * Like line-in: an external source feeding the zone, with local queue authority
 * (the control point drives track changes via SetAVTransportURI, not our queue).
 */
export function resolveDlnaInputStart(): InputStartDecision {
  return { mode: 'dlna', queueAuthority: 'local' };
}
