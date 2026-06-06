/**
 * Known-problematic AirPlay device models, ported from Music Assistant's
 * `BROKEN_AIRPLAY_MODELS`. RAOP (and AP2) playback on these is unreliable and
 * there is no server-side workaround; we only warn so the cause is visible in
 * logs. Matching is best-effort against whatever identifiers discovery exposes
 * (mDNS name + TXT `am`/`model`/`manufacturer`).
 */
const KNOWN_PROBLEM_PATTERNS: ReadonlyArray<{ match: RegExp; note: string }> = [
  {
    // Samsung TVs/monitors are repeatedly reported as broken over RAOP and AP2
    // (AP2 needs PTP timing they don't honour). See MA support tracker.
    match: /samsung/i,
    note: 'Samsung AirPlay support is known to be unreliable; playback may be silent or distorted. No server-side workaround.',
  },
];

/**
 * Return a warning note if any of the supplied device identifiers match a
 * known-problematic model, otherwise null.
 *
 * :param identifiers: device name and TXT-record values (am/model/manufacturer).
 */
export function findAirplayQuirkWarning(identifiers: Array<string | undefined>): string | null {
  const haystack = identifiers.filter((v): v is string => Boolean(v)).join(' ');
  if (!haystack) {
    return null;
  }
  for (const { match, note } of KNOWN_PROBLEM_PATTERNS) {
    if (match.test(haystack)) {
      return note;
    }
  }
  return null;
}
