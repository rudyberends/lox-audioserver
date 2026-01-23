import assert from 'node:assert/strict';
import { test } from './testHarness';
import { stopWithTimeout } from '../src/runtime/stopWithTimeout';

type LogEntry = {
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createTestLogger(): { log: any; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const log = {
    info: (message: string, data?: Record<string, unknown>) => {
      entries.push({ level: 'info', message, data });
    },
    warn: (message: string, data?: Record<string, unknown>) => {
      entries.push({ level: 'warn', message, data });
    },
    error: (message: string, data?: Record<string, unknown>) => {
      entries.push({ level: 'error', message, data });
    },
  };
  return { log, entries };
}

test('stopWithTimeout logs stopped on clean shutdown', async () => {
  const { log, entries } = createTestLogger();
  const result = await stopWithTimeout('demo', async () => {
    await delay(5);
  }, 50, log);

  assert.equal(result.kind, 'stopped');
  assert.ok(entries.some((entry) => entry.level === 'info' && entry.message === 'service demo stopped'));
  assert.equal(entries.some((entry) => entry.level === 'warn'), false);
  assert.equal(entries.some((entry) => entry.level === 'error'), false);
});

test('stopWithTimeout logs timeout without clean stop', async () => {
  const { log, entries } = createTestLogger();
  const result = await stopWithTimeout('demo', async () => {
    await delay(30);
  }, 5, log);

  assert.equal(result.kind, 'timeout');
  await delay(40);

  const warn = entries.find((entry) => entry.level === 'warn');
  assert.ok(warn);
  assert.equal(warn?.message, 'service demo stop timed out');
  assert.equal((warn?.data as { timeoutMs?: number } | undefined)?.timeoutMs, 5);
  assert.equal(entries.some((entry) => entry.level === 'info'), false);
});

test('stopWithTimeout logs errors on failure', async () => {
  const { log, entries } = createTestLogger();
  const result = await stopWithTimeout('demo', async () => {
    throw new Error('boom');
  }, 50, log);

  assert.equal(result.kind, 'error');
  const error = entries.find((entry) => entry.level === 'error');
  assert.ok(error);
  assert.equal(error?.message, 'failed to stop demo');
  assert.equal((error?.data as { message?: string } | undefined)?.message, 'boom');
  assert.equal(entries.some((entry) => entry.level === 'info'), false);
  assert.equal(entries.some((entry) => entry.level === 'warn'), false);
});
