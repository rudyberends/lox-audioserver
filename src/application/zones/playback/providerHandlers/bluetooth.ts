import type { InputStartDecision } from '@/application/zones/playback/types';

/**
 * A phone playing into the room over Bluetooth.
 *
 * Like AirPlay and line-in: something outside the server decides what plays and when, so the queue
 * stays local and the zone follows. The phone is the one holding the track list, and it is in
 * someone's hand.
 */
export function resolveBluetoothInputStart(): InputStartDecision {
  return { mode: 'bluetooth', queueAuthority: 'local' };
}
