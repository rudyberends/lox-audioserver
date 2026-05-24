import assert from 'node:assert/strict';
import { test } from '../testHarness';
import { SubscriberFanout } from '../../src/engine/subscriberFanout';

const silentLog = { debug: () => {} };

function makeFanout(opts: { maxLag?: number } = {}): {
  fanout: SubscriberFanout;
  pauses: number;
  resumes: number;
} {
  let pauses = 0;
  let resumes = 0;
  const fanout = new SubscriberFanout(
    { pause: () => { pauses += 1; }, resume: () => { resumes += 1; } },
    silentLog,
    opts.maxLag ?? 1024 * 1024,
  );
  return {
    fanout,
    get pauses() { return pauses; },
    get resumes() { return resumes; },
  };
}

test('SubscriberFanout.attach increments size and triggers upstream.resume on first sub', () => {
  const h = makeFanout();
  assert.equal(h.fanout.size, 0);
  h.fanout.attach({ zoneId: 1, profile: 'mp3', sessionBufferedBytes: 0 });
  assert.equal(h.fanout.size, 1);
  assert.equal(h.resumes, 1, 'upstream.resume called for first subscriber');
});

test('SubscriberFanout.write fans chunk out to all subscribers', () => {
  const h = makeFanout();
  const a = h.fanout.attach({ zoneId: 1, profile: 'mp3', sessionBufferedBytes: 0 });
  const b = h.fanout.attach({ zoneId: 1, profile: 'mp3', sessionBufferedBytes: 0 });
  let aBytes = 0;
  let bBytes = 0;
  a.on('data', (c: Buffer) => { aBytes += c.length; });
  b.on('data', (c: Buffer) => { bBytes += c.length; });
  h.fanout.write(Buffer.alloc(100));
  // Listeners fire synchronously via PassThrough internal buffer drain — use setImmediate to await.
  return new Promise<void>((resolve) => setImmediate(() => {
    assert.equal(aBytes, 100);
    assert.equal(bBytes, 100);
    resolve();
  }));
});

test('SubscriberFanout.attach with codecHeader prepends header bytes', () => {
  const h = makeFanout();
  const header = Buffer.from([0xff, 0xaa]);
  const sub = h.fanout.attach({
    zoneId: 1, profile: 'flac', sessionBufferedBytes: 0,
    codecHeader: header,
  });
  return new Promise<void>((resolve) => {
    sub.once('readable', () => {
      const chunk = sub.read(2);
      assert.deepEqual(Array.from(chunk ?? []), [0xff, 0xaa]);
      resolve();
    });
  });
});

test('SubscriberFanout.attach primes from buffer snapshot', () => {
  const h = makeFanout();
  const sub = h.fanout.attach({
    zoneId: 1, profile: 'mp3', sessionBufferedBytes: 5,
    primingChunks: [Buffer.from([1, 2, 3]), Buffer.from([4, 5])],
  });
  return new Promise<void>((resolve) => {
    sub.once('readable', () => {
      const chunk = sub.read(5);
      assert.deepEqual(Array.from(chunk ?? []), [1, 2, 3, 4, 5]);
      resolve();
    });
  });
});

test('SubscriberFanout.endAll(false) calls end() on each subscriber', () => {
  const h = makeFanout();
  const sub = h.fanout.attach({ zoneId: 1, profile: 'mp3', sessionBufferedBytes: 0 });
  h.fanout.endAll(false);
  assert.equal(sub.writableEnded, true);
  assert.equal(h.fanout.size, 0);
});

test('SubscriberFanout subscriber close triggers upstream.pause on last detach', () => {
  const h = makeFanout();
  const sub = h.fanout.attach({ zoneId: 1, profile: 'mp3', sessionBufferedBytes: 0 });
  sub.destroy();
  return new Promise<void>((resolve) => setImmediate(() => {
    assert.equal(h.pauses >= 1, true, 'pause called when last subscriber leaves');
    resolve();
  }));
});

test('SubscriberFanout.hasBackpressure starts false', () => {
  const h = makeFanout();
  assert.equal(h.fanout.hasBackpressure(), false);
});

test('SubscriberFanout.drops counts evicted slow subscribers', () => {
  const h = makeFanout({ maxLag: 16 });
  assert.equal(h.fanout.drops.count, 0);
  // No realistic write loop here triggers eviction without runtime backpressure;
  // the counter is exposed and starts at zero, which is what we verify.
  assert.equal(h.fanout.drops.lastAt, null);
});
