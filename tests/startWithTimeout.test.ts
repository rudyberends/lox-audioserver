import assert from 'node:assert/strict';
import { test } from './testHarness';
import { startWithTimeout } from '../src/runtime/startWithTimeout';

type LogLine = { level: string; message: string };

/** Collects what was logged, so the timeout path can be asserted on rather than inferred. */
function recordingLogger(lines: LogLine[]): Parameters<typeof startWithTimeout>[3] {
  const record = (level: string) => (message: string) => {
    lines.push({ level, message });
  };
  return {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    spam: record('spam'),
  } as unknown as Parameters<typeof startWithTimeout>[3];
}

test('startWithTimeout resolves as soon as the subsystem is up', async () => {
  const lines: LogLine[] = [];
  let started = false;
  await startWithTimeout(
    'quick',
    async () => {
      started = true;
    },
    1000,
    recordingLogger(lines),
  );
  assert.equal(started, true);
  assert.deepEqual(lines, [], 'a normal start should stay silent; the subsystem logs itself');
});

test('startWithTimeout gives up on a start that never settles', async () => {
  const lines: LogLine[] = [];
  // The node-upnp 0.3.0 shape: a promise nothing ever resolves.
  await startWithTimeout('hangs', () => new Promise<void>(() => {}), 20, recordingLogger(lines));
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.level, 'warn');
  assert.match(lines[0]?.message ?? '', /service hangs start timed out/);
});

test('startWithTimeout rethrows a real failure instead of degrading it', async () => {
  const lines: LogLine[] = [];
  await assert.rejects(
    () =>
      startWithTimeout(
        'broken',
        async () => {
          throw new Error('EADDRINUSE');
        },
        1000,
        recordingLogger(lines),
      ),
    /EADDRINUSE/,
    'an error is a verdict a supervisor can act on, so it must still reach markFailed',
  );
});

test('startWithTimeout reports a subsystem that comes up after its timeout', async () => {
  const lines: LogLine[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await startWithTimeout('slow', () => pending, 20, recordingLogger(lines));
  assert.equal(lines.length, 1, 'startup carried on');

  release();
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lines.length, 2);
  assert.equal(lines[1]?.level, 'info');
  assert.match(lines[1]?.message ?? '', /service slow started after its timeout/);
});

test('startWithTimeout surfaces a failure that lands after its timeout', async () => {
  const lines: LogLine[] = [];
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, rejectFn) => {
    reject = rejectFn;
  });
  await startWithTimeout('late-failure', () => pending, 20, recordingLogger(lines));

  reject(new Error('bind refused'));
  await pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lines.length, 2);
  assert.equal(lines[1]?.level, 'error');
  assert.match(lines[1]?.message ?? '', /failed to start late-failure/);
});
