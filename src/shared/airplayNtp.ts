const NTP_EPOCH_DELTA_SECONDS = 2208988800n; // seconds between 1900 and 1970 epochs

/**
 * Convert a Unix timestamp in milliseconds to an NTP 64-bit timestamp.
 * Uses BigInt to avoid precision loss.
 */
export function unixMsToNtp(unixMs: number, offsetMs = 0): bigint {
  const totalMs = BigInt(Math.max(0, Math.floor(unixMs + offsetMs)));
  const seconds = totalMs / 1000n;
  const micros = (totalMs % 1000n) * 1000n;

  const ntpSeconds = seconds + NTP_EPOCH_DELTA_SECONDS;
  const ntpFraction = (micros << 32n) / 1_000_000n;

  return (ntpSeconds << 32n) | ntpFraction;
}

/**
 * Add seconds (can be fractional) to an NTP timestamp.
 */
export function addSecondsToNtp(ntpTimestamp: bigint, seconds: number): bigint {
  if (seconds === 0) return ntpTimestamp;
  const secPart = BigInt(Math.trunc(seconds));
  const frac = seconds - Math.trunc(seconds);
  const ntpSeconds = ntpTimestamp >> 32n;
  const ntpFraction = ntpTimestamp & 0xFFFFFFFFn;
  const newSeconds = ntpSeconds + secPart;
  const newFraction = ntpFraction + BigInt(Math.round(frac * 2 ** 32));
  // handle carry
  const carry = newFraction >> 32n;
  const fraction = newFraction & 0xFFFFFFFFn;
  return ((newSeconds + carry) << 32n) | fraction;
}

/**
 * Convert an NTP 64-bit timestamp to Unix milliseconds.
 */
export function ntpToUnixMs(ntpTimestamp: bigint): number {
  const ntpSeconds = ntpTimestamp >> 32n;
  const ntpFraction = ntpTimestamp & 0xFFFFFFFFn;
  const unixSeconds = ntpSeconds - NTP_EPOCH_DELTA_SECONDS;
  const micros = (ntpFraction * 1_000_000n) >> 32n;
  const ms = Number(unixSeconds * 1000n + micros / 1000n);
  return ms;
}
