import type { PlayerRegistryPort } from '@/ports/PlayerRegistryPort';
import { getPlayer } from '@/application/playback/playerRegistry';

export function createPlayerRegistryPort(): PlayerRegistryPort {
  return {
    getPlayer,
  };
}
