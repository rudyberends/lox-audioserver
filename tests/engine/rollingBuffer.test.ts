import assert from 'node:assert/strict';
import { test } from '../testHarness';
import { RollingBuffer } from '../../src/engine/rollingBuffer';

test('RollingBuffer with maxBytes=0 is disabled (push is a no-op)', () => {
  const buf = new RollingBuffer(0, false);
  buf.push(Buffer.alloc(1024));
  assert.equal(buf.bytes, 0);
  assert.equal(buf.snapshot().length, 0);
});

test('RollingBuffer FIFO mode trims oldest chunks past maxBytes', () => {
  const buf = new RollingBuffer(100, false);
  buf.push(Buffer.alloc(40, 1));
  buf.push(Buffer.alloc(40, 2));
  buf.push(Buffer.alloc(40, 3));
  assert.ok(buf.bytes <= 100, 'bytes never exceed maxBytes');
  const snap = buf.snapshot();
  // The 1-filled chunk should have been evicted; remaining chunks contain 2 and 3.
  const all = Buffer.concat(snap.map((b) => Buffer.from(b)));
  assert.ok(!all.includes(1), 'oldest chunk evicted');
  assert.ok(all.includes(2));
  assert.ok(all.includes(3));
});

test('RollingBuffer FIFO truncates oversized single chunk to tail', () => {
  const buf = new RollingBuffer(50, false);
  const big = Buffer.alloc(200);
  for (let i = 0; i < 200; i++) big[i] = i;
  buf.push(big);
  assert.equal(buf.bytes, 50);
  const snap = buf.snapshot();
  assert.equal(snap[0]?.[0], 150, 'tail-50 of 200-byte buffer starts at byte 150');
});

test('RollingBuffer keepInitial mode stops accepting once filled', () => {
  const buf = new RollingBuffer(100, true);
  buf.push(Buffer.alloc(60, 1));
  buf.push(Buffer.alloc(60, 2));
  // Should have written 60 + 40 (clamped), then ignored further writes.
  assert.equal(buf.bytes, 100);
  buf.push(Buffer.alloc(50, 3));
  assert.equal(buf.bytes, 100);
  const all = Buffer.concat(buf.snapshot().map((b) => Buffer.from(b)));
  assert.ok(!all.includes(3), 'further pushes after fill are dropped');
});

test('RollingBuffer.clear() resets state', () => {
  const buf = new RollingBuffer(100, false);
  buf.push(Buffer.alloc(50));
  assert.equal(buf.bytes, 50);
  buf.clear();
  assert.equal(buf.bytes, 0);
  assert.equal(buf.snapshot().length, 0);
});

test('RollingBuffer.firstChunk returns first or undefined', () => {
  const buf = new RollingBuffer(100, false);
  assert.equal(buf.firstChunk(), undefined);
  const c = Buffer.from([1, 2, 3]);
  buf.push(c);
  assert.equal(buf.firstChunk()?.[0], 1);
});

test('RollingBuffer.capacity returns maxBytes', () => {
  const buf = new RollingBuffer(123, false);
  assert.equal(buf.capacity, 123);
});
