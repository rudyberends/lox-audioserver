import assert from 'node:assert/strict';
import { test } from '../testHarness';
import { PcmFrameAligner } from '../../src/engine/pcmFrameAligner';

test('PcmFrameAligner returns aligned prefix when chunk is frame-multiple', () => {
  // 2 channels × 16 bit = 4 bytes/frame
  const aligner = new PcmFrameAligner(2, 16);
  const chunk = Buffer.alloc(20); // 5 frames exactly
  const out = aligner.align(chunk);
  assert.equal(out?.length, 20);
});

test('PcmFrameAligner buffers remainder until next chunk completes a frame', () => {
  const aligner = new PcmFrameAligner(2, 16); // 4 bytes/frame
  const first = aligner.align(Buffer.from([1, 2, 3])); // 3 bytes → no full frame
  assert.equal(first, null);
  const second = aligner.align(Buffer.from([4, 5])); // total 5 bytes → 1 frame + 1 remainder
  assert.equal(second?.length, 4);
  assert.deepEqual(Array.from(second ?? []), [1, 2, 3, 4]);
});

test('PcmFrameAligner.reset clears remainder', () => {
  const aligner = new PcmFrameAligner(2, 16);
  aligner.align(Buffer.from([1, 2, 3]));
  aligner.reset();
  const next = aligner.align(Buffer.from([10, 11, 12, 13]));
  assert.deepEqual(Array.from(next ?? []), [10, 11, 12, 13], 'no stale remainder leaks');
});

test('PcmFrameAligner handles 24-bit stereo (6 bytes/frame)', () => {
  const aligner = new PcmFrameAligner(2, 24);
  const out = aligner.align(Buffer.alloc(13)); // 2 frames + 1 byte remainder
  assert.equal(out?.length, 12);
});
