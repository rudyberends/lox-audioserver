/**
 * Standardize a zone's output protocol on its grouping family. The sendspin
 * engine carries cast/dlna/sonos as `sendspin-<device>`, but for grouping (and
 * the player's hint) those are all simply "sendspin". Returns null when unknown.
 */
export function normalizeOutputProtocol(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.toLowerCase().startsWith('sendspin') ? 'sendspin' : raw;
}

/** Resolve a zone's standardized output protocol from its technical snapshot. */
export function resolveZoneOutputProtocol(
  snapshot: { transports?: string[]; activeOutput?: string | null } | null | undefined,
): string | null {
  return normalizeOutputProtocol(snapshot?.transports?.[0] ?? snapshot?.activeOutput ?? null);
}
