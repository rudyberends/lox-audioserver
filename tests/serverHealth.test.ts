import assert from 'node:assert/strict';
import type { HealthReport } from '../src/domain/server/health';
import { test } from './testHarness';
import { ServerLifecycle } from '../src/domain/server/lifecycle';
import { healthHttpStatus, worstStatus } from '../src/domain/server/health';
import { buildHealthReport, type HealthInputs } from '../src/adapters/http/api/healthReport';

// /health used to answer a hardcoded `status: "ok"` with an unconditional 200, which a
// supervisor cannot act on: a wedged server looked identical to a working one. So
// integrators supervised us from outside instead — the LoxBerry plugin greps `docker ps`
// on a five-minute cron, where `Up (unhealthy)` counts as healthy and a crash-loop between
// two checks is invisible. These tests pin the verdict such a caller now relies on.

function inputs(overrides: Partial<HealthInputs> = {}): HealthInputs {
  const lifecycle = new ServerLifecycle();
  lifecycle.markReady();
  return {
    lifecycle: lifecycle.snapshot(),
    version: '4.0.0-test',
    zones: [{ id: 1, name: 'Kitchen', restarts: 0, lastError: null }],
    loxone: null,
    ...overrides,
  };
}

const named = (report: { checks: Array<{ name: string }> }) => report.checks.map((c) => c.name);
const byName = (report: HealthReport, name: string) => report.checks.find((c) => c.name === name);

test('a healthy server says so, and explains nothing', () => {
  const report = buildHealthReport(inputs());
  assert.equal(report.status, 'ok');
  assert.equal(report.phase, 'ready');
  // A `detail` on every healthy check is noise in a response meant to be polled.
  assert.ok(
    report.checks.every((c) => c.status === 'ok' && !('detail' in c)),
    'healthy checks carry no detail',
  );
});

test('a zone whose engine keeps failing makes the server degraded, not unhealthy', () => {
  // Degraded is the distinction that matters: music is still playing elsewhere, so a
  // supervisor must not restart on this. That is why it stays a 200.
  const report = buildHealthReport(
    inputs({
      zones: [
        { id: 1, name: 'Kitchen', restarts: 0, lastError: null },
        { id: 2, name: 'Study', restarts: 2, lastError: 'ffmpeg exited 1' },
      ],
    }),
  );
  assert.equal(report.status, 'degraded');
  assert.equal(healthHttpStatus(report.status), 200, 'do not invite a restart');
  const audio = byName(report, 'audio');
  assert.ok(audio?.detail?.includes('Study'), 'names the zone, so nobody has to hunt');
  assert.ok(audio?.detail?.includes('ffmpeg exited 1'), 'and says why');
});

test('repeated restarts without a standing error are still worth reporting', () => {
  const quiet = buildHealthReport(
    inputs({ zones: [{ id: 1, name: 'Kitchen', restarts: 1, lastError: null }] }),
  );
  assert.equal(quiet.status, 'ok', 'one restart is a format change, not a fault');

  const noisy = buildHealthReport(
    inputs({ zones: [{ id: 1, name: 'Kitchen', restarts: 9, lastError: null }] }),
  );
  assert.equal(noisy.status, 'degraded');
  assert.ok(byName(noisy, 'audio')?.detail?.includes('9'), 'says how many');
});

test('a server still starting is unhealthy, and reports only that', () => {
  // Every other check would be describing subsystems that are not up yet.
  const starting = new ServerLifecycle();
  const report = buildHealthReport(
    inputs({
      lifecycle: starting.snapshot(),
      zones: [{ id: 1, name: 'Kitchen', restarts: 99, lastError: 'boom' }],
      loxone: { enabled: true, paired: false },
    }),
  );
  assert.equal(report.status, 'unhealthy');
  assert.deepEqual(named(report), ['startup']);
  assert.equal(healthHttpStatus(report.status), 503);
  assert.equal(report.uptimeSec, null, 'never ready means no uptime to report');
});

test('a failed start reports the reason rather than just refusing', () => {
  const failed = new ServerLifecycle();
  failed.markFailed(new Error('port 7090 already in use'));
  const report = buildHealthReport(inputs({ lifecycle: failed.snapshot() }));
  assert.equal(report.status, 'unhealthy');
  assert.equal(report.phase, 'failed');
  assert.equal(byName(report, 'startup')?.detail, 'port 7090 already in use');
});

test('the Loxone link is a check only where Loxone is part of the install', () => {
  // A server nobody ever pointed a Miniserver at should not report on Loxone at all;
  // an absent integration is not a degraded one.
  assert.ok(!named(buildHealthReport(inputs({ loxone: null }))).includes('loxone'));

  // Paired but switched off is the state worth flagging: someone expects it to work.
  const off = buildHealthReport(inputs({ loxone: { enabled: false, paired: true } }));
  assert.equal(off.status, 'degraded');
  assert.ok(byName(off, 'loxone')?.detail?.includes('off'));

  const waiting = buildHealthReport(inputs({ loxone: { enabled: true, paired: false } }));
  assert.equal(waiting.status, 'degraded');

  const good = buildHealthReport(inputs({ loxone: { enabled: true, paired: true } }));
  assert.equal(good.status, 'ok');
});

test('the worst check wins, so nothing hides behind healthy neighbours', () => {
  assert.equal(worstStatus(['ok', 'ok']), 'ok');
  assert.equal(worstStatus(['ok', 'degraded', 'ok']), 'degraded');
  assert.equal(worstStatus(['degraded', 'unhealthy', 'ok']), 'unhealthy');
  assert.equal(worstStatus([]), 'ok');
});

// Readiness is what replaces the plugin UI blocking 600 seconds on a file lock to guess
// whether a restart finished.

test('lifecycle separates starting from ready from failed', () => {
  let clock = 1000;
  const lifecycle = new ServerLifecycle(() => clock);
  assert.equal(lifecycle.isReady(), false);
  assert.equal(lifecycle.snapshot().phase, 'starting');
  assert.equal(lifecycle.snapshot().readyAt, null);

  clock = 5000;
  lifecycle.markReady();
  assert.equal(lifecycle.isReady(), true);
  assert.equal(lifecycle.snapshot().readyAt, 5000);
  assert.equal(lifecycle.snapshot().startedAt, 1000, 'process start is a separate fact');
  assert.equal(lifecycle.snapshot().readyCount, 1);
});

test('a restart is not ready, and does not erase that it once was', () => {
  let clock = 1000;
  const lifecycle = new ServerLifecycle(() => clock);
  lifecycle.markReady();

  clock = 2000;
  lifecycle.markStarting();
  assert.equal(lifecycle.isReady(), false, 'the HTTP service is down during a soft restart');
  assert.equal(lifecycle.snapshot().readyAt, 1000, 'still records when it last worked');

  clock = 3000;
  lifecycle.markReady();
  assert.equal(lifecycle.snapshot().readyAt, 3000);
  assert.equal(lifecycle.snapshot().readyCount, 2, 'more than once means it restarted');
});

test('becoming ready clears an earlier failure', () => {
  const lifecycle = new ServerLifecycle();
  lifecycle.markFailed('config unreadable');
  assert.equal(lifecycle.snapshot().error, 'config unreadable');
  lifecycle.markReady();
  assert.equal(lifecycle.snapshot().error, null, 'it is serving now');
  assert.equal(lifecycle.snapshot().phase, 'ready');
});

test('uptime is measured from ready, not from process start', () => {
  // Measuring from process start counts the boot sequence as service, and after a restart
  // keeps counting across a window in which nothing was served.
  const lifecycle = new ServerLifecycle();
  lifecycle.markReady();
  const report = buildHealthReport(inputs({ lifecycle: lifecycle.snapshot() }));
  assert.ok(report.uptimeSec !== null && report.uptimeSec < 5, 'just became ready');
});
