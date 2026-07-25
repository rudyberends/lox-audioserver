/**
 * Opaque identity for one engine playback session.
 *
 * The engine keys its sessions by a plain number, but that number is NOT
 * inherently a zone: a session may be owned by a zone (normal playback) or by a
 * non-zone consumer such as the DLNA media server serving a track to an
 * arbitrary renderer. `SessionKey` makes that distinction explicit at the type
 * level while staying numerically compatible with `zoneId`.
 *
 * Construction goes through the two helpers below so callers declare intent:
 *   - `zoneSessionKey(zoneId)` — a zone's key IS its zoneId, so every engine Map
 *     key keeps the exact same numeric value (zero behaviour change for zones,
 *     and termination routing / subscriber URLs stay bit-identical).
 *   - `allocateEphemeralSessionKey()` — a fresh key from a disjoint negative
 *     range for non-zone consumers, which can never collide with a positive
 *     zoneId, so it never resolves against any zone state.
 */
export type SessionKey = number & { readonly __sessionKey: unique symbol };

/** A zone's engine session key is its zoneId (numerically identical). */
export function zoneSessionKey(zoneId: number): SessionKey {
  return zoneId as SessionKey;
}

let ephemeralSeq = 0;

/**
 * Allocate an ephemeral session key for a non-zone consumer. Keys are negative
 * and monotonic within a large window, so they never equal a (positive) zoneId
 * and never look up against zone state.
 */
export function allocateEphemeralSessionKey(): SessionKey {
  ephemeralSeq = (ephemeralSeq + 1) % 1_000_000_000;
  return (-1 - ephemeralSeq) as SessionKey;
}
