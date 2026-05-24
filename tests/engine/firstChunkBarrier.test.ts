import assert from 'node:assert/strict';
import { test } from '../testHarness';
import { FirstChunkBarrier } from '../../src/engine/firstChunkBarrier';

test('FirstChunkBarrier.signal resolves a pending wait()', async () => {
  const barrier = new FirstChunkBarrier();
  barrier.arm();
  const waiter = barrier.wait(1000);
  assert.equal(barrier.signal(), true);
  assert.equal(await waiter, true);
  assert.equal(barrier.hasFired(), true);
});

test('FirstChunkBarrier.signal is idempotent', () => {
  const barrier = new FirstChunkBarrier();
  barrier.arm();
  assert.equal(barrier.signal(), true);
  assert.equal(barrier.signal(), false, 'second signal returns false');
});

test('FirstChunkBarrier.wait returns immediately when already fired', async () => {
  const barrier = new FirstChunkBarrier();
  barrier.arm();
  barrier.signal();
  const ok = await barrier.wait(1000);
  assert.equal(ok, true);
});

test('FirstChunkBarrier.wait times out when no signal', async () => {
  const barrier = new FirstChunkBarrier();
  barrier.arm();
  const ok = await barrier.wait(30);
  assert.equal(ok, false);
});

test('FirstChunkBarrier.abort resolves waiters with false', async () => {
  const barrier = new FirstChunkBarrier();
  barrier.arm();
  const waiter = barrier.wait(1000);
  barrier.abort();
  assert.equal(await waiter, false);
});

test('FirstChunkBarrier.chainRestart carries waiters to the next arm cycle', async () => {
  const barrier = new FirstChunkBarrier();
  barrier.arm();
  const waiter = barrier.wait(1000);
  barrier.chainRestart();
  barrier.arm();
  // Existing waiter should still be pending; new signal resolves it.
  barrier.signal();
  assert.equal(await waiter, true);
});

test('FirstChunkBarrier reset on a fresh arm() clears hasFired', () => {
  const barrier = new FirstChunkBarrier();
  barrier.arm();
  barrier.signal();
  assert.equal(barrier.hasFired(), true);
  barrier.arm();
  assert.equal(barrier.hasFired(), false);
});
