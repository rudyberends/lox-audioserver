import assert from 'node:assert/strict';
import { test } from './testHarness';
import { computeAlertStartDelays } from '../src/application/zones/helpers/alertStartAlignment';

// A bell must ring in every room at once. "Started together" is not enough: each zone
// waits out its own amp wake-up and its own output buffer before anything is heard, so
// the fast zones have to lead with silence until the slowest one catches up (#359).

test('warm zones with different output buffers are padded to the slowest (#359)', () => {
  const delays = computeAlertStartDelays([
    { zoneId: 1, wakeUpMs: 0, outputLatencyMs: 200 },
    { zoneId: 2, wakeUpMs: 0, outputLatencyMs: 900 },
  ]);

  // Zone 1 leads with 700 ms of silence; both are then audible at 900 ms.
  assert.equal(delays.get(1), 700);
  assert.equal(delays.get(2), 0);
  assert.equal((delays.get(1) ?? 0) + 200, (delays.get(2) ?? 0) + 900);
});

test('a single warm zone rings as soon as it can', () => {
  const delays = computeAlertStartDelays([{ zoneId: 1, wakeUpMs: 0, outputLatencyMs: 600 }]);
  assert.equal(delays.get(1), 0);
});

test('a cold zone still gets its full amp wake-up delay', () => {
  // Padding must never drop below the wake-up delay — the amp would swallow the start.
  const delays = computeAlertStartDelays([{ zoneId: 1, wakeUpMs: 3000, outputLatencyMs: 500 }]);
  assert.equal(delays.get(1), 3000);
});

test('a warm zone waits for a cold sibling, buffer included', () => {
  const delays = computeAlertStartDelays([
    { zoneId: 1, wakeUpMs: 3000, outputLatencyMs: 200 },
    { zoneId: 2, wakeUpMs: 0, outputLatencyMs: 900 },
  ]);

  assert.equal(delays.get(1), 3000);
  assert.equal(delays.get(2), 2300);
  // Both rooms hear it 3200 ms after the button, together.
  assert.equal((delays.get(1) ?? 0) + 200, 3200);
  assert.equal((delays.get(2) ?? 0) + 900, 3200);
});

test('zones whose outputs report the same buffer keep the old floor behaviour', () => {
  // This is what the previous implementation did: max wake-up delay, forced on everyone.
  const delays = computeAlertStartDelays([
    { zoneId: 1, wakeUpMs: 2000, outputLatencyMs: 400 },
    { zoneId: 2, wakeUpMs: 0, outputLatencyMs: 400 },
    { zoneId: 3, wakeUpMs: 500, outputLatencyMs: 400 },
  ]);

  assert.deepEqual([...delays.values()], [2000, 2000, 2000]);
});

test('no target zones resolves to no delays', () => {
  assert.equal(computeAlertStartDelays([]).size, 0);
});
