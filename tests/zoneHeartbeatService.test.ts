import assert from 'node:assert/strict';
import { test } from './testHarness';
import { ZoneHeartbeatService } from '../src/application/zones/services/ZoneHeartbeatService';
import type { ZoneContext } from '../src/application/zones/internal/zoneTypes';
import type { ZoneState } from '../src/domain/zones/zoneState';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function makeCtx(id: number, state: Partial<ZoneState> | null = {}): ZoneContext {
  return {
    id,
    state: state as ZoneState | null,
    lastZoneBroadcastAt: 0,
  } as unknown as ZoneContext;
}

test('ZoneHeartbeatService re-broadcasts each zone state on tick', async () => {
  const ctxA = makeCtx(1, { mode: 'play' });
  const ctxB = makeCtx(2, { mode: 'stop' });
  const broadcasts: ZoneState[] = [];

  const heartbeat = new ZoneHeartbeatService({
    listZones: () => [ctxA, ctxB],
    notifier: {
      notifyZoneStateChanged: (state) => {
        broadcasts.push(state);
      },
    },
  }, 5);

  heartbeat.start();
  await wait(15);
  heartbeat.stop();

  assert.ok(broadcasts.length >= 2);
  // Last two should always include both zones (broadcast goes in list order)
  const lastTwo = broadcasts.slice(-2);
  assert.equal(lastTwo[0]?.mode, 'play');
  assert.equal(lastTwo[1]?.mode, 'stop');
});

test('ZoneHeartbeatService skips zones with null state', async () => {
  const ctxAlive = makeCtx(1, { mode: 'play' });
  const ctxDead = makeCtx(2, null);
  const broadcasts: ZoneState[] = [];

  const heartbeat = new ZoneHeartbeatService({
    listZones: () => [ctxAlive, ctxDead],
    notifier: {
      notifyZoneStateChanged: (state) => {
        broadcasts.push(state);
      },
    },
  }, 5);

  heartbeat.start();
  await wait(10);
  heartbeat.stop();

  assert.ok(broadcasts.every((s) => s?.mode === 'play'));
});

test('ZoneHeartbeatService stamps lastZoneBroadcastAt on the context', async () => {
  const ctx = makeCtx(1, { mode: 'play' });
  ctx.lastZoneBroadcastAt = 0;
  const before = Date.now();

  const heartbeat = new ZoneHeartbeatService({
    listZones: () => [ctx],
    notifier: { notifyZoneStateChanged: () => {} },
  }, 5);

  heartbeat.start();
  await wait(10);
  heartbeat.stop();

  assert.ok(ctx.lastZoneBroadcastAt >= before);
});

test('ZoneHeartbeatService start is idempotent', async () => {
  const broadcasts: ZoneState[] = [];
  const ctx = makeCtx(1, { mode: 'play' });

  const heartbeat = new ZoneHeartbeatService({
    listZones: () => [ctx],
    notifier: {
      notifyZoneStateChanged: (state) => {
        broadcasts.push(state);
      },
    },
  }, 5);

  heartbeat.start();
  heartbeat.start();
  heartbeat.start();
  await wait(12);
  heartbeat.stop();

  // Multiple start() calls must not create multiple timers; expect ~2 ticks in 12 ms
  assert.ok(broadcasts.length <= 4, `expected <=4 ticks, got ${broadcasts.length}`);
});

test('ZoneHeartbeatService stop halts further broadcasts', async () => {
  const broadcasts: ZoneState[] = [];
  const ctx = makeCtx(1, { mode: 'play' });

  const heartbeat = new ZoneHeartbeatService({
    listZones: () => [ctx],
    notifier: {
      notifyZoneStateChanged: (state) => {
        broadcasts.push(state);
      },
    },
  }, 5);

  heartbeat.start();
  await wait(10);
  heartbeat.stop();
  const countAfterStop = broadcasts.length;
  await wait(20);
  assert.equal(broadcasts.length, countAfterStop);
});

test('ZoneHeartbeatService stop without start is a safe no-op', () => {
  const heartbeat = new ZoneHeartbeatService({
    listZones: () => [],
    notifier: { notifyZoneStateChanged: () => {} },
  });
  heartbeat.stop();
});
