import type { ZoneConfigEntry } from '../../config/configStore';

/**
 * Merges a list of zone config entries, filtering out duplicates by zone id.
 */
export function mergeZoneConfigEntries(
  existingZones: ZoneConfigEntry[],
  newZoneEntries: ZoneConfigEntry[],
): { merged: ZoneConfigEntry[]; added: ZoneConfigEntry[] } {
  const result = [...existingZones];
  const added: ZoneConfigEntry[] = [];
  const seenIds = new Set(existingZones.map((zone) => zone.id));

  newZoneEntries.forEach((entry) => {
    if (!seenIds.has(entry.id)) {
      result.push(entry);
      added.push(entry);
      seenIds.add(entry.id);
    }
  });

  return { merged: result, added };
}
