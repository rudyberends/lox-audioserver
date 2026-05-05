import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from './testHarness';
import {
  PowerManager,
  SystemPowerManagerExecutor,
  normalizePowerManagerConfig,
  type PowerManagerExecutor,
} from '../src/application/zones/services/powerManager';

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

async function withHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('power manager keeps default off delay aligned with admin UI', () => {
  const normalized = normalizePowerManagerConfig(null);
  assert.equal(normalized.offDelayMs, 300000);

  const explicitImmediate = normalizePowerManagerConfig({ offDelayMs: 0 });
  assert.equal(explicitImmediate.offDelayMs, 0);
});

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
  assert.deepEqual(signalUpdates, [{ zoneId: 1, signal: 1 }]);
  pm.clearAll();
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
      offDelayMs: 0,
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

test('system power manager sends Basic Auth for URL credentials', async () => {
  const executor = new SystemPowerManagerExecutor();
  let authorization: string | undefined;
  await withHttpServer(
    (req, res) => {
      authorization = req.headers.authorization;
      res.writeHead(200);
      res.end('ok');
    },
    async (baseUrl) => {
      const target = baseUrl.replace('://', '://user:p%40ss@');
      await executor.execute(
        { type: 'url', config: { onUrl: `${target}/dev/sps/io/Amp/Ein`, offUrl: '' } },
        1,
      );
    },
  );

  assert.equal(authorization, `Basic ${Buffer.from('user:p@ss').toString('base64')}`);
});

test('system power manager reports URL client errors as failures', async () => {
  const executor = new SystemPowerManagerExecutor();
  await withHttpServer(
    (_req, res) => {
      res.writeHead(401);
      res.end('unauthorized');
    },
    async (baseUrl) => {
      await assert.rejects(
        () =>
          executor.execute(
            { type: 'url', config: { onUrl: `${baseUrl}/dev/sps/io/Amp/Ein`, offUrl: '' } },
            1,
          ),
        /http 401/,
      );
    },
  );
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

test('power manager delays pause off by default', async () => {
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

  assert.deepEqual(executor.calls, [{ type: 'gpio', signal: 1 }]);
  pm.clearAll();
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
      offDelayMs: 0,
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
