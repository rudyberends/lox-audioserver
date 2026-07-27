import assert from 'node:assert/strict';
import { test } from './testHarness';
import { LineInActivationRegistry } from '../src/adapters/inputs/linein/lineInActivationRegistry';

// Transport commands for a line-in source have to survive the gap until the bridge's next status
// poll, which is seconds away. Delivery is at-most-once by construction: draining the queue is the
// acknowledgement, because a replayed "next" would skip two tracks.

test('commands are delivered once, in order', () => {
  const registry = new LineInActivationRegistry();
  registry.activate('linein-1');
  registry.enqueueCommand('linein-1', 'play');
  registry.enqueueCommand('linein-1', 'next');
  registry.enqueueCommand('linein-1', 'disc', ['3']);

  assert.deepEqual(registry.takeCommands('linein-1'), [
    { command: 'play', args: [] },
    { command: 'next', args: [] },
    { command: 'disc', args: ['3'] },
  ]);
  assert.deepEqual(registry.takeCommands('linein-1'), [], 'a second poll must not replay them');
});

test('queues are kept per input', () => {
  const registry = new LineInActivationRegistry();
  registry.enqueueCommand('linein-1', 'play');
  registry.enqueueCommand('linein-2', 'next');
  assert.deepEqual(registry.takeCommands('linein-2'), [{ command: 'next', args: [] }]);
  assert.deepEqual(registry.takeCommands('linein-1'), [{ command: 'play', args: [] }]);
});

test('deactivating drops what was queued for that source', () => {
  // The commands were meant for the source the zone just left; running them afterwards would drive
  // hardware that is no longer selected.
  const registry = new LineInActivationRegistry();
  registry.activate('linein-1');
  registry.enqueueCommand('linein-1', 'play');
  registry.deactivate('linein-1');
  assert.deepEqual(registry.takeCommands('linein-1'), []);
});

test('an offline bridge cannot build an unbounded backlog', () => {
  // Every press queues, but a bridge that has been away for an hour must not come back to hundreds
  // of commands. Oldest are dropped: a stale play matters less than the latest press.
  const registry = new LineInActivationRegistry();
  for (let i = 0; i < 40; i += 1) {
    registry.enqueueCommand('linein-1', `cmd${i}`);
  }
  const drained = registry.takeCommands('linein-1');
  assert.equal(drained.length, 16);
  assert.equal(drained[0]?.command, 'cmd24', 'the oldest were dropped, not the newest');
  assert.equal(drained[15]?.command, 'cmd39');
});

test('blank commands and ids are ignored', () => {
  const registry = new LineInActivationRegistry();
  registry.enqueueCommand('linein-1', '   ');
  registry.enqueueCommand('  ', 'play');
  assert.deepEqual(registry.takeCommands('linein-1'), []);
});

test('activation state is independent of the command queue', () => {
  const registry = new LineInActivationRegistry();
  registry.activate('linein-1');
  registry.enqueueCommand('linein-1', 'play');
  registry.takeCommands('linein-1');
  assert.equal(registry.isActive('linein-1'), true, 'draining commands must not deactivate');
});
