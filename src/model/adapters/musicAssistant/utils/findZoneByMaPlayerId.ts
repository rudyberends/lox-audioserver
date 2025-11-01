import { zoneStateStore } from '@/runtime/zones/zoneStateStore';

/**
 * Finds the Loxone zone that corresponds to a given Music Assistant player ID.
 */
export function findZoneByMaPlayerId(maPlayerId: string): { zoneId: number; zoneName: string } | undefined {
  if (typeof maPlayerId !== 'string' || maPlayerId.trim().length === 0) {
    return undefined;
  }

  const normalized = maPlayerId.toLowerCase();

  for (const zone of zoneStateStore.getAll()) {
    const adapterProps = zone.adapterProps as Record<string, unknown> | undefined;
    const storedId = (adapterProps?.maPlayerId as string | undefined)?.toLowerCase();
    if (storedId && storedId === normalized) {
      return { zoneId: zone.playerid, zoneName: zone.name };
    }
  }

  return undefined;
}