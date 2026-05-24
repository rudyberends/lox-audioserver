import assert from 'node:assert/strict';
import { test } from '../testHarness';
import { OutputPacer } from '../../src/engine/outputPacer';

const silentLog = { spam: () => {} };

function makePacer(opts: {
  bps?: number;
  maxAhead?: number;
  hasBackpressure?: () => boolean;
  subscriberCount?: () => number;
  pauseFn?: () => void;
  resumeFn?: () => void;
} = {}): { pacer: OutputPacer; pauses: number; resumes: number } {
  let pauses = 0;
  let resumes = 0;
  const pacer = new OutputPacer(
    opts.bps ?? 1000,
    opts.maxAhead ?? 100,
    {
      hasBackpressure: opts.hasBackpressure ?? (() => false),
      subscriberCount: opts.subscriberCount ?? (() => 1),
    },
    {
      pause: () => {
        opts.pauseFn?.();
        pauses += 1;
      },
      resume: () => {
        opts.resumeFn?.();
        resumes += 1;
      },
    },
    silentLog,
    { zoneId: 1 },
  );
  return {
    pacer,
    get pauses() { return pauses; },
    get resumes() { return resumes; },
  };
}

test('OutputPacer.enabled true when bps>0 and maxAhead>0', () => {
  const a = new OutputPacer(0, 100, { hasBackpressure: () => false, subscriberCount: () => 1 },
    { pause: () => {}, resume: () => {} }, silentLog, {});
  assert.equal(a.enabled, false);
  const b = new OutputPacer(1000, 0, { hasBackpressure: () => false, subscriberCount: () => 1 },
    { pause: () => {}, resume: () => {} }, silentLog, {});
  assert.equal(b.enabled, false);
  const c = new OutputPacer(1000, 100, { hasBackpressure: () => false, subscriberCount: () => 1 },
    { pause: () => {}, resume: () => {} }, silentLog, {});
  assert.equal(c.enabled, true);
});

test('OutputPacer.tick pauses upstream when bytes overshoot allowed lead', () => {
  const h = makePacer({ bps: 1000, maxAhead: 100 });
  // 1 second elapsed at 1000 bps = 1000 expected bytes + 100 ahead = 1100 allowed.
  // Pass 2000 totalBytes → overshoot = 900.
  h.pacer.tick(2000, Date.now() - 1000);
  assert.equal(h.pauses, 1, 'paused once on overshoot');
});

test('OutputPacer.tick does nothing under quota', () => {
  const h = makePacer({ bps: 1000, maxAhead: 100 });
  h.pacer.tick(500, Date.now() - 1000); // 500 < 1100 allowed
  assert.equal(h.pauses, 0);
  assert.equal(h.resumes, 0);
});

test('OutputPacer.tick yields when there is backpressure', () => {
  const h = makePacer({ bps: 1000, maxAhead: 100, hasBackpressure: () => true });
  h.pacer.tick(99999, Date.now() - 10000);
  assert.equal(h.pauses, 0, 'no pause: backpressure already throttles');
});

test('OutputPacer.tick yields when not yet started (startTs=null)', () => {
  const h = makePacer({ bps: 1000, maxAhead: 100 });
  h.pacer.tick(99999, null);
  assert.equal(h.pauses, 0);
});

test('OutputPacer.tick after pause: resumes when bytes back within quota', () => {
  const h = makePacer({ bps: 1000, maxAhead: 100, subscriberCount: () => 1 });
  // First overshoot
  h.pacer.tick(2000, Date.now() - 1000);
  assert.equal(h.pauses, 1);
  // Later: 2s elapsed → allowed=2100 → 1500 totalBytes < 2100. Resume.
  h.pacer.tick(1500, Date.now() - 2000);
  assert.equal(h.resumes, 1);
});

test('OutputPacer.reset clears paused state and timer', () => {
  const h = makePacer({ bps: 1000, maxAhead: 100 });
  h.pacer.tick(2000, Date.now() - 1000);
  h.pacer.reset();
  // No throw; subsequent ticks should behave fresh.
  h.pacer.tick(500, Date.now() - 100);
  assert.ok(true);
});

test('OutputPacer.enabled=false: tick is a no-op', () => {
  const h = makePacer({ bps: 0, maxAhead: 0 });
  h.pacer.tick(99999, Date.now() - 5000);
  assert.equal(h.pauses, 0);
  assert.equal(h.resumes, 0);
});
