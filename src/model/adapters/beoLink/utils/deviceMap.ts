import logger from '@/utils/troxorLogger';

/**
 * -----------------------------------------------------------------------------
 * BeoLink Device Map
 * -----------------------------------------------------------------------------
 * Global in-memory map that links BeoLink device JIDs to internal zone IDs.
 * Keeps adapter-specific data out of the core runtime.
 * -----------------------------------------------------------------------------
 */

const deviceMap = new Map<string, number>();

/** Normalizes a JID string to lowercase and trims whitespace. */
function normalizeJid(jid?: string): string | undefined {
  if (typeof jid !== 'string') {
    return undefined;
  }
  const trimmed = jid.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Registers a JID → ZoneID mapping.
 */
export function registerDeviceJid(zoneId: number, jid?: string): void {
  const normalized = normalizeJid(jid);
  if (!normalized) {
    return;
  }

  deviceMap.set(normalized, zoneId);
  logger.debug(`[BeoLinkDeviceMap] Registered ${normalized} → zone ${zoneId}`);
}

/**
 * Removes all JID mappings for a given zone.
 */
export function unregisterDeviceJid(zoneId: number): void {
  for (const [jid, id] of deviceMap.entries()) {
    if (id === zoneId) {
      deviceMap.delete(jid);
      logger.debug(`[BeoLinkDeviceMap] Unregistered zone ${zoneId} (${jid})`);
    }
  }
}

/**
 * Resolves a zone ID from a BeoLink JID.
 */
export function findZoneIdByJid(jid?: string): number | undefined {
  const normalized = normalizeJid(jid);
  const result = normalized ? deviceMap.get(normalized) : undefined;

  if (normalized && !result) {
    logger.debug(`[BeoLinkDeviceMap] No zone found for ${normalized}`);
  }

  return result;
}

/**
 * Debug utility: dumps all known mappings to the log.
 */
export function dumpDeviceMap(): void {
  if (deviceMap.size === 0) {
    logger.debug('[BeoLinkDeviceMap] No device mappings currently stored');
    return;
  }

  logger.debug(
    `[BeoLinkDeviceMap] Current mappings:\n${Array.from(deviceMap.entries())
      .map(([jid, id]) => `  ${jid} → ${id}`)
      .join('\n')}`,
  );
}