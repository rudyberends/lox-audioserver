import assert from 'node:assert/strict';
import { test } from './testHarness';
import { PowerManager, type PowerManagerExecutor } from '../src/application/zones/services/powerManager';

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

test('power manager stays active for state tracking when no config exists', async () => {
  const executor = new FakeExecutor();
  const signalUpdates: Array<{ zoneId: number; signal: 0 | 1 }> = [];
  const pm = new PowerManager(noopLogger, executor, (zoneId, signal) => {
    signalUpdates.push({ zoneId, signal });
  });
  pm.onStatePatch(
    1,
    { id: 1, name: 'Living', sourceMac: '00:00:00:00:00:01', volumes: {} as any } as any,
    { mode: 'play' } as any,
    { ...baseState, mode: 'play' } as any,
  );
  await wait(10);
  pm.onStatePatch(
    1,
    { id: 1, name: 'Living', sourceMac: '00:00:00:00:00:01', volumes: {} as any } as any,
    { mode: 'stop' } as any,
    { ...baseState, mode: 'stop' } as any,
  );
  await wait(10);
  assert.equal(executor.calls.length, 0);
  assert.deepEqual(signalUpdates, [
    { zoneId: 1, signal: 1 },
    { zoneId: 1, signal: 0 },
  ]);
});

test('power manager runs all configured action types', async () => {
  const executor = new FakeExecutor();
  const pm = new PowerManager(noopLogger, executor);
  const zoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {} as any,
    powerManager: {
      gpio: { enabled: true, pin: 21 },
      url: { enabled: true, onUrl: 'http://amp/on', offUrl: 'http://amp/off' },
      udp: { enabled: true, host: '127.0.0.1', port: 1234, onPayload: 'ON', offPayload: 'OFF' },
      crelay: { enabled: true, serial: '/dev/ttyUSB0', relay: '1' },
    },
  } as any;

  pm.onStatePatch(1, zoneConfig, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  assert.deepEqual(executor.calls, [
    { type: 'gpio', signal: 1 },
    { type: 'url', signal: 1 },
    { type: 'udp', signal: 1 },
    { type: 'crelay', signal: 1 },
  ]);

  pm.onStatePatch(1, zoneConfig, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(10);
  assert.deepEqual(executor.calls, [
    { type: 'gpio', signal: 1 },
    { type: 'url', signal: 1 },
    { type: 'udp', signal: 1 },
    { type: 'crelay', signal: 1 },
    { type: 'gpio', signal: 0 },
    { type: 'url', signal: 0 },
    { type: 'udp', signal: 0 },
    { type: 'crelay', signal: 0 },
  ]);
});

test('power manager forwards gpio backend details to executor', async () => {
  const calls: Array<{ type: string; signal: 0 | 1; action: any }> = [];
  const executor: PowerManagerExecutor = {
    async execute(action: any, signal: 0 | 1): Promise<void> {
      calls.push({ type: action.type, signal, action });
    },
  };
  const pm = new PowerManager(noopLogger, executor);
  const zoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {} as any,
    powerManager: {
      gpio: {
        enabled: true,
        pin: 22,
        driver: 'gpioset',
        chip: 'gpiochip4',
        gpiosetPath: '/usr/bin/gpioset',
      },
    },
  } as any;

  pm.onStatePatch(1, zoneConfig, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);

  assert.deepEqual(calls, [
    {
      type: 'gpio',
      signal: 1,
      action: {
        type: 'gpio',
        config: {
          pin: 22,
          activeHigh: true,
          chip: 'gpiochip4',
          gpiosetPath: '/usr/bin/gpioset',
        },
      },
    },
  ]);
});

test('power manager accepts crelay without serial', async () => {
  const calls: Array<{ type: string; signal: 0 | 1; action: any }> = [];
  const executor: PowerManagerExecutor = {
    async execute(action: any, signal: 0 | 1): Promise<void> {
      calls.push({ type: action.type, signal, action });
    },
  };
  const pm = new PowerManager(noopLogger, executor);
  const zoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {} as any,
    powerManager: {
      crelay: { enabled: true, relay: '1' },
    },
  } as any;

  pm.onStatePatch(1, zoneConfig, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);

  assert.deepEqual(calls, [
    {
      type: 'crelay',
      signal: 1,
      action: {
        type: 'crelay',
        config: {
          serial: null,
          relay: '1',
          binaryPath: '/usr/local/bin/crelay',
        },
      },
    },
  ]);
});

test('power manager applies off delay and cancels pending off when play resumes', async () => {
  const executor = new FakeExecutor();
  const pm = new PowerManager(noopLogger, executor);
  const zoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {} as any,
    powerManager: {
      offDelayMs: 40,
      gpio: { enabled: true, pin: 21 },
      url: { enabled: true, onUrl: 'http://amp/on', offUrl: 'http://amp/off' },
    },
  } as any;

  pm.onStatePatch(1, zoneConfig, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  pm.onStatePatch(1, zoneConfig, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(20);
  pm.onStatePatch(1, zoneConfig, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(50);

  assert.deepEqual(executor.calls, [
    { type: 'gpio', signal: 1 },
    { type: 'url', signal: 1 },
  ]);
});

test('power manager treats pause as off by default', async () => {
  const executor = new FakeExecutor();
  const pm = new PowerManager(noopLogger, executor);
  const zoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {} as any,
    powerManager: {
      gpio: { enabled: true, pin: 21 },
    },
  } as any;

  pm.onStatePatch(1, zoneConfig, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  pm.onStatePatch(1, zoneConfig, { mode: 'pause' } as any, { ...baseState, mode: 'pause' } as any);
  await wait(10);

  assert.deepEqual(executor.calls, [
    { type: 'gpio', signal: 1 },
    { type: 'gpio', signal: 0 },
  ]);
});

test('power manager can stay on during pause via activeModes', async () => {
  const executor = new FakeExecutor();
  const pm = new PowerManager(noopLogger, executor);
  const zoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {} as any,
    powerManager: {
      activeModes: ['play', 'pause'],
      gpio: { enabled: true, pin: 21 },
    },
  } as any;

  pm.onStatePatch(1, zoneConfig, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  pm.onStatePatch(1, zoneConfig, { mode: 'pause' } as any, { ...baseState, mode: 'pause' } as any);
  await wait(10);
  pm.onStatePatch(1, zoneConfig, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(10);

  assert.deepEqual(executor.calls, [
    { type: 'gpio', signal: 1 },
    { type: 'gpio', signal: 0 },
  ]);
});

test('power manager ignores offDelayMs when offDelayEnabled is false', async () => {
  const executor = new FakeExecutor();
  const pm = new PowerManager(noopLogger, executor);
  const zoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {} as any,
    powerManager: {
      offDelayEnabled: false,
      offDelayMs: 1000,
      gpio: { enabled: true, pin: 21 },
    },
  } as any;

  pm.onStatePatch(1, zoneConfig, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  pm.onStatePatch(1, zoneConfig, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(20);

  assert.deepEqual(executor.calls, [
    { type: 'gpio', signal: 1 },
    { type: 'gpio', signal: 0 },
  ]);
});
