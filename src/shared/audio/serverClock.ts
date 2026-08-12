import { performance } from 'node:perf_hooks';

/**
 * The one timeline audio timestamps are expressed on.
 *
 * Monotonic microseconds since this process started — deliberately *not* epoch time. Two reasons,
 * and the second is why this file exists rather than each caller reaching for a clock:
 *
 *  - Monotonic cannot jump. An NTP step or a DST change would otherwise move every scheduled frame,
 *    which for a timeline that things are rendered *at* is a glitch rather than a correction.
 *  - It is the timeline Sendspin already uses (`serverNowUs()` in node-sendspin is this same
 *    expression), and Sendspin's frame timestamps are presentation times its clients sync to. A
 *    second clock beside it would make `timestampUs` mean different things on the same stream
 *    depending on which output a zone happens to have — which is exactly the bug this replaces:
 *    the analysis tap stamped `Date.now()`, so an epoch time and a process-relative time travelled
 *    down one SSE and no consumer could tell them apart.
 *
 * Because the origin is arbitrary, a consumer cannot interpret these numbers on its own. Anything
 * publishing them must also publish a reference reading of this clock so the other end can map the
 * two — see the `analysis.clock` event on `/zones/{id}/analysis`.
 */
export function serverClockUs(): number {
  return Math.round(performance.now() * 1000);
}
