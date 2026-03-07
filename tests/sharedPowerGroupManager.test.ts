import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SharedPowerGroupManager } from '../src/application/zones/services/sharedPowerGroupManager';
import type { PowerManagerExecutor } from '../src/application/zones/services/powerManager';

type Call = { type: string; signal: 0 | 1 };

class FakeExecutor implements PowerManagerExecutor {
  public calls: Call[] = [];

  public async execute(action: { type: string }, signal: 0 | 1): Promise<void> {
    this.calls.push({ type: action.type, signal });
  }
}

const noopLogger = {
  debug: () => {},
  spam: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  isEnabled: () => false,
} as any;

const baseState = { mode: 'stop' } as any;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('shared power group turns on while any member zone is active', async () => {
  const executor = new FakeExecutor();
  const manager = new SharedPowerGroupManager(noopLogger, executor);
  manager.configure(
    [
      {
        id: 'amp-living',
        powerManager: {
          gpio: { enabled: true, pin: 22 },
        },
      },
    ],
    [
      {
        id: 1,
        name: 'Living',
        sourceMac: '00:00:00:00:00:01',
        volumes: {} as any,
        powerManager: { powerGroupId: 'amp-living' },
      } as any,
      {
        id: 2,
        name: 'Kitchen',
        sourceMac: '00:00:00:00:00:02',
        volumes: {} as any,
        powerManager: { powerGroupId: 'amp-living' },
      } as any,
    ],
  );

  manager.onStatePatch(1, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  manager.onStatePatch(2, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  manager.onStatePatch(1, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(10);
  manager.onStatePatch(2, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(10);

  assert.deepEqual(executor.calls, [
    { type: 'gpio', signal: 1 },
    { type: 'gpio', signal: 0 },
  ]);
});

test('shared power group respects member activeModes during pause', async () => {
  const executor = new FakeExecutor();
  const manager = new SharedPowerGroupManager(noopLogger, executor);
  manager.configure(
    [
      {
        id: 'amp-living',
        powerManager: {
          gpio: { enabled: true, pin: 22 },
        },
      },
    ],
    [
      {
        id: 1,
        name: 'Living',
        sourceMac: '00:00:00:00:00:01',
        volumes: {} as any,
        powerManager: { powerGroupId: 'amp-living', activeModes: ['play', 'pause'] },
      } as any,
    ],
  );

  manager.onStatePatch(1, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  manager.onStatePatch(1, { mode: 'pause' } as any, { ...baseState, mode: 'pause' } as any);
  await wait(10);
  manager.onStatePatch(1, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(10);

  assert.deepEqual(executor.calls, [
    { type: 'gpio', signal: 1 },
    { type: 'gpio', signal: 0 },
  ]);
});

test('shared power group ignores group-level delays and switches immediately', async () => {
  const executor = new FakeExecutor();
  const manager = new SharedPowerGroupManager(noopLogger, executor);
  manager.configure(
    [
      {
        id: 'amp-living',
        powerManager: {
          onDelayMs: 5_000,
          offDelayMs: 5_000,
          gpio: { enabled: true, pin: 22 },
        },
      },
    ],
    [
      {
        id: 1,
        name: 'Living',
        sourceMac: '00:00:00:00:00:01',
        volumes: {} as any,
        powerManager: { powerGroupId: 'amp-living' },
      } as any,
    ],
  );

  manager.onStatePatch(1, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  manager.onStatePatch(1, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(10);

  assert.deepEqual(executor.calls, [
    { type: 'gpio', signal: 1 },
    { type: 'gpio', signal: 0 },
  ]);
});
