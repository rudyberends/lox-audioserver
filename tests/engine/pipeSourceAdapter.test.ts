import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from '../testHarness';
import { PipeSourceAdapter } from '../../src/engine/pipeSourceAdapter';

test('PipeSourceAdapter.current returns undefined before adopt', () => {
  const a = new PipeSourceAdapter();
  assert.equal(a.current(), undefined);
});

test('PipeSourceAdapter.onData receives chunks until detach', () => {
  const a = new PipeSourceAdapter();
  const stream = new PassThrough();
  a.adopt(stream);
  const chunks: Buffer[] = [];
  a.onData((c) => chunks.push(c));
  stream.write(Buffer.from([1, 2, 3]));
  return new Promise<void>((resolve) => setImmediate(() => {
    assert.equal(chunks.length, 1);
    a.detach();
    stream.write(Buffer.from([4, 5]));
    setImmediate(() => {
      assert.equal(chunks.length, 1, 'detach removed data listener');
      resolve();
    });
  }));
});

test('PipeSourceAdapter.adopt() detaches previous stream first', () => {
  const a = new PipeSourceAdapter();
  const first = new PassThrough();
  const second = new PassThrough();
  a.adopt(first);
  let firstChunks = 0;
  a.onData(() => { firstChunks += 1; });
  a.adopt(second);
  first.write(Buffer.from([1])); // listener should be detached
  return new Promise<void>((resolve) => setImmediate(() => {
    assert.equal(firstChunks, 0);
    assert.equal(a.current(), second);
    resolve();
  }));
});

test('PipeSourceAdapter.onError fires for stream errors', () => {
  const a = new PipeSourceAdapter();
  const stream = new PassThrough();
  a.adopt(stream);
  let captured: unknown;
  a.onError((err) => { captured = err; });
  stream.emit('error', new Error('boom'));
  assert.equal((captured as Error).message, 'boom');
});

test('PipeSourceAdapter.onEndOrClose fires on stream end', () => {
  const a = new PipeSourceAdapter();
  const stream = new PassThrough();
  a.adopt(stream);
  let fired = false;
  // A PassThrough stays paused until something flows through; attaching a data
  // listener flips it to flowing mode so 'end' actually fires after end().
  a.onData(() => {});
  a.onEndOrClose(() => { fired = true; });
  stream.end();
  return new Promise<void>((resolve) => setImmediate(() => {
    assert.equal(fired, true);
    resolve();
  }));
});

test('PipeSourceAdapter.pause/resume delegate to stream when supported', () => {
  const a = new PipeSourceAdapter();
  const stream = new PassThrough();
  a.adopt(stream);
  assert.equal(a.pause(), true);
  assert.equal(a.resume(), true);
});

test('PipeSourceAdapter.pause returns false when no stream adopted', () => {
  const a = new PipeSourceAdapter();
  assert.equal(a.pause(), false);
  assert.equal(a.resume(), false);
});

test('PipeSourceAdapter.detach() clears current stream', () => {
  const a = new PipeSourceAdapter();
  const stream = new PassThrough();
  a.adopt(stream);
  a.detach();
  assert.equal(a.current(), undefined);
});
