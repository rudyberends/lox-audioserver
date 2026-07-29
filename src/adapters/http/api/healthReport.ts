/**
 * Turns the signals the server already tracks into a verdict.
 *
 * Every input here existed before this file did — `streamStats.restarts`,
 * `streamStats.lastError`, the Loxone pairing flags — and was surfaced raw to the Admin UI
 * with nothing interpreting it. That is why integrators ended up supervising us by grepping
 * `docker ps`: the data was there, but no code turned it into "should something be done?".
 *
 * The bar for a check is that a human would act on it. Deliberately not included: host
 * telemetry (load average, cores, clock offset) and per-provider token state. Those are
 * facts about the machine or a service account, not about whether this server is serving,
 * and putting them behind one verdict means a busy host makes an audio server look broken.
 */
import {
  check,
  worstStatus,
  type HealthCheck,
  type HealthReport,
  type HealthStatus,
} from '@/domain/server/health';
import type { ServerLifecycleSnapshot } from '@/domain/server/lifecycle';

/**
 * How many engine restarts on one zone before the zone counts as degraded.
 *
 * A single restart is normal — a format change or a device reconnect causes one — so the
 * threshold sits above the noise floor. It reports rather than resets: the count is
 * lifetime, so a long-lived server that recovered hours ago still shows the scar. That is
 * the right trade for `degraded`, which asks for a look rather than an action.
 */
const ZONE_RESTART_BUDGET = 5;

export type HealthInputs = {
  lifecycle: ServerLifecycleSnapshot;
  version: string;
  /** Per-zone engine health, for zones that currently have a session. */
  zones: Array<{
    id: number;
    name: string;
    restarts: number;
    lastError: string | null;
  }>;
  /**
   * The Loxone link, or null when this server is not meant to talk to Loxone at all —
   * in which case it is not a health signal and is left out of the report entirely.
   */
  loxone: { enabled: boolean; paired: boolean } | null;
};

/** The engine check: a zone whose encoder keeps dying is the failure that matters most. */
function zoneChecks(zones: HealthInputs['zones']): HealthCheck[] {
  const failing = zones.filter((zone) => zone.lastError);
  const restarting = zones.filter(
    (zone) => !zone.lastError && zone.restarts >= ZONE_RESTART_BUDGET,
  );
  const checks: HealthCheck[] = [];
  if (failing.length > 0) {
    // Named rather than counted: "3 zones failing" sends someone hunting for which.
    const named = failing.map((zone) => `${zone.name} (${zone.lastError})`).join('; ');
    checks.push(check('audio', 'degraded', `last playback attempt failed on ${named}`));
  } else if (restarting.length > 0) {
    const named = restarting.map((zone) => `${zone.name} (${zone.restarts}×)`).join('; ');
    checks.push(check('audio', 'degraded', `repeated engine restarts on ${named}`));
  } else {
    checks.push(check('audio', 'ok'));
  }
  return checks;
}

/**
 * The Loxone check.
 *
 * Paired-but-disabled is the state worth reporting: the Miniserver completed pairing, so
 * someone expects it to work, but the integration is switched off and no Loxone client can
 * reach this server. Never `unhealthy` — a server without Loxone still plays music, and a
 * restart would not reconnect it.
 */
function loxoneCheck(loxone: NonNullable<HealthInputs['loxone']>): HealthCheck {
  if (loxone.paired && !loxone.enabled) {
    return check('loxone', 'degraded', 'paired with a Miniserver but the integration is off');
  }
  if (loxone.enabled && !loxone.paired) {
    return check('loxone', 'degraded', 'enabled but no Miniserver has paired yet');
  }
  return check('loxone', 'ok');
}

export function buildHealthReport(inputs: HealthInputs): HealthReport {
  const { lifecycle } = inputs;
  const checks: HealthCheck[] = [];

  // Startup comes first and, when it has not finished, is the only thing worth saying:
  // every other check would be reporting on subsystems that are not up yet.
  if (lifecycle.phase === 'failed') {
    checks.push(check('startup', 'unhealthy', lifecycle.error ?? 'startup failed'));
  } else if (lifecycle.phase !== 'ready') {
    checks.push(check('startup', 'unhealthy', 'still starting'));
  } else {
    checks.push(...zoneChecks(inputs.zones));
    if (inputs.loxone) {
      checks.push(loxoneCheck(inputs.loxone));
    }
  }

  const status: HealthStatus = worstStatus(checks.map((entry) => entry.status));
  return {
    status,
    version: inputs.version,
    // Measured from ready, not from process start: see HealthReport.uptimeSec.
    uptimeSec:
      lifecycle.readyAt === null ? null : Math.round((Date.now() - lifecycle.readyAt) / 1000),
    phase: lifecycle.phase,
    checks,
  };
}
