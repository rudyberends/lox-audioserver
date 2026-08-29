/** What sits between "the alert started" and "the alert is heard", for one zone. */
export type AlertZoneLead = {
  zoneId: number;
  /** Silence a cold amp needs before it passes anything (0 when it is already on). */
  wakeUpMs: number;
  /** Buffer the zone's output is holding, i.e. how far behind the server the room is. */
  outputLatencyMs: number;
};

/**
 * Wake-up silence (ms) per zone that makes a multi-zone alert land in every room
 * at the same moment.
 *
 * Every zone is padded up to the slowest one: prepend `slowest lead minus my own
 * output buffer`, never less than my own amp's wake-up delay (dropping below that
 * would let the amp swallow the start). A single zone, or zones whose outputs
 * report the same buffer, come out at exactly the delay they had before.
 */
export function computeAlertStartDelays(leads: readonly AlertZoneLead[]): Map<number, number> {
  const slowestLeadMs = leads.reduce(
    (max, lead) => Math.max(max, lead.wakeUpMs + lead.outputLatencyMs),
    0,
  );
  const delays = new Map<number, number>();
  for (const lead of leads) {
    delays.set(lead.zoneId, Math.max(slowestLeadMs - lead.outputLatencyMs, lead.wakeUpMs, 0));
  }
  return delays;
}
