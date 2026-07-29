/**
 * A health verdict a supervisor can act on.
 *
 * `/api/v1/health` used to answer a hardcoded `status: "ok"` with an unconditional 200,
 * which is indistinguishable from a server that is wedged. So integrators built their own:
 * the LoxBerry plugin's UI does a bare `GET /` and treats any HTTP code except a connection
 * failure as healthy — a 500 passes — while its watchdog ignores HTTP entirely and greps
 * `docker ps` every five minutes.
 *
 * The point of a verdict is that it answers one question: *should something be done?* That
 * makes the middle state the important one. "Every zone is silent because nobody asked for
 * music" and "every zone is silent because the encoder keeps dying" are both `ok` to a
 * liveness probe and completely different to an operator, so `degraded` exists to separate
 * them — and it deliberately does not fail a liveness check, because restarting a server
 * whose Loxone link is down fixes nothing.
 */

/**
 * `ok` — nothing to do. `degraded` — working, but something needs attention; do not
 * restart on this alone. `unhealthy` — not serving; intervention is warranted.
 */
export type HealthStatus = 'ok' | 'degraded' | 'unhealthy';

/** One subsystem's contribution to the verdict. */
export interface HealthCheck {
  /** Stable identifier, so a client can key on a specific check rather than parse prose. */
  name: string;
  status: HealthStatus;
  /**
   * Why this status, in one line, aimed at whoever has to fix it. Omitted when `ok`:
   * a healthy check needs no explanation and saying so adds noise to every response.
   */
  detail?: string;
}

export interface HealthReport {
  status: HealthStatus;
  version: string;
  /**
   * Seconds since the server last became ready — not since the process started.
   *
   * Measuring from process start counts the boot sequence as service and, after a
   * restart, keeps counting across a window in which nothing was served. Null while
   * the server has never been ready.
   */
  uptimeSec: number | null;
  /** Whether the server is serving; see ServerPhase. */
  phase: string;
  checks: HealthCheck[];
}

/**
 * The worst status among the checks, which is the whole verdict.
 *
 * Worst-wins rather than a score or a quorum: a supervisor needs a single actionable
 * answer, and averaging would let one dead subsystem hide behind several healthy ones.
 */
export function worstStatus(statuses: HealthStatus[]): HealthStatus {
  if (statuses.includes('unhealthy')) {
    return 'unhealthy';
  }
  return statuses.includes('degraded') ? 'degraded' : 'ok';
}

/**
 * The HTTP status a report should be served with.
 *
 * `degraded` stays 200 on purpose. Anything polling this is deciding whether to act, and
 * the commonest reaction to a non-2xx is a restart — which is wrong for a degraded server
 * that is still playing music. Only `unhealthy` earns a 503, which is also what a load
 * balancer or `docker healthcheck` reads without parsing a body.
 */
export function healthHttpStatus(status: HealthStatus): number {
  return status === 'unhealthy' ? 503 : 200;
}

/** Builds a check, keeping `detail` off healthy entries. */
export function check(name: string, status: HealthStatus, detail?: string): HealthCheck {
  return status === 'ok' ? { name, status } : { name, status, detail: detail ?? '' };
}
