/**
 * High-resolution clock helpers for Sendspin timestamps.
 */
export function serverNowUs(): number {
  // Monotonic microseconds, mirroring aiosendspin's `loop.time()`*1e6 behaviour.
  // performance.now() is monotonic and expresses milliseconds since process start.
  return Math.round(performance.now() * 1000);
}
