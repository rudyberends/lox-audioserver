import assert from 'node:assert/strict';
import { test } from './testHarness';
import { FlacFrameSplitter } from '../src/engine/flacFrameSplitter';

/** CRC-8 (poly 0x07) over a byte range, as FLAC specifies for frame headers. */
function crc8(bytes: number[]): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

/**
 * Builds a synthetic FLAC frame: a 4-byte header with a valid CRC-8, then
 * `payloadLen` bytes of body. `fill` lets a test place arbitrary bytes — including
 * fake sync patterns — inside the body.
 */
function makeFrame(payloadLen: number, fill = 0x11): Buffer {
  const header = [0xff, 0xf8, 0x69, 0x18];
  const frame = Buffer.alloc(4 + 1 + payloadLen, fill);
  frame[0] = header[0]!;
  frame[1] = header[1]!;
  frame[2] = header[2]!;
  frame[3] = header[3]!;
  frame[4] = crc8(header);
  return frame;
}

/** Feeds `data` through the splitter in fixed-size slices. */
function splitInChunks(data: Buffer, chunkSize: number): Buffer[] {
  const splitter = new FlacFrameSplitter();
  const frames: Buffer[] = [];
  for (let off = 0; off < data.length; off += chunkSize) {
    frames.push(...splitter.push(data.subarray(off, Math.min(off + chunkSize, data.length))));
  }
  frames.push(...splitter.flush());
  return frames;
}

test('one chunk holding many frames is split into individual frames', () => {
  // The bug: ffmpeg emits 32 KB+ chunks holding a dozen frames, and libavcodec
  // clients decode only the first frame per packet and discard the remainder.
  const frames = [makeFrame(100), makeFrame(200), makeFrame(150), makeFrame(300)];
  const stream = Buffer.concat(frames);

  const out = splitInChunks(stream, stream.length);
  assert.equal(out.length, 4);
  out.forEach((frame, i) => assert.deepEqual(frame, frames[i], `frame ${i}`));
});

test('frame boundaries are found regardless of how the stream is chunked', () => {
  const frames = [makeFrame(64), makeFrame(500), makeFrame(33), makeFrame(1200), makeFrame(7)];
  const stream = Buffer.concat(frames);

  // 1-byte chunks are the pathological case: every boundary straddles a chunk.
  for (const chunkSize of [1, 2, 7, 64, 999, stream.length]) {
    const out = splitInChunks(stream, chunkSize);
    assert.equal(out.length, frames.length, `chunkSize=${chunkSize}: frame count`);
    assert.deepEqual(Buffer.concat(out), stream, `chunkSize=${chunkSize}: byte-identical`);
  }
});

test('a sync pattern inside frame audio data does not split the frame', () => {
  // Measured on a real 24-bit/96 kHz stream: 107 of 1049 byte pairs matching the
  // sync pattern were audio data, not frame headers. Splitting on the pattern
  // alone would cut frames in half — the CRC-8 check is what rejects them.
  const frame = makeFrame(200);
  // Plant 0xFFF8 in the body, at a position whose CRC-8 will not validate.
  frame[80] = 0xff;
  frame[81] = 0xf8;
  frame[82] = 0x00;
  frame[83] = 0x00;
  frame[84] = 0x00; // deliberately not the correct CRC-8
  const next = makeFrame(120);
  const stream = Buffer.concat([frame, next]);

  const out = splitInChunks(stream, stream.length);
  assert.equal(out.length, 2, 'the planted sync must not create a third frame');
  assert.deepEqual(out[0], frame);
  assert.deepEqual(out[1], next);
});

test('every emitted frame starts with a sync code', () => {
  const stream = Buffer.concat([makeFrame(90), makeFrame(410), makeFrame(15)]);
  for (const frame of splitInChunks(stream, 13)) {
    assert.equal(frame[0], 0xff);
    assert.ok(frame[1]! >= 0xf8 && frame[1]! <= 0xfb, 'second byte within sync range');
  }
});

test('the trailing frame is only released on flush', () => {
  // FLAC frames carry no length field, so the last frame stays pending until the
  // stream ends — otherwise it would be emitted truncated.
  const frames = [makeFrame(50), makeFrame(60)];
  const splitter = new FlacFrameSplitter();
  const early = splitter.push(Buffer.concat(frames));
  assert.equal(early.length, 1, 'only the first frame is complete');
  assert.ok(splitter.pendingBytes > 0, 'the last frame is held back');

  const tail = splitter.flush();
  assert.equal(tail.length, 1);
  assert.deepEqual(Buffer.concat([...early, ...tail]), Buffer.concat(frames));
  assert.equal(splitter.pendingBytes, 0);
});

test('leading bytes before the first sync are discarded', () => {
  // The file header (fLaC + STREAMINFO) is stripped by the caller, but any stray
  // bytes ahead of the first frame belong to no frame.
  const frame = makeFrame(70);
  const stream = Buffer.concat([Buffer.from([0x01, 0x02, 0x03]), frame, makeFrame(80)]);
  const out = splitInChunks(stream, 5);
  assert.deepEqual(out[0], frame, 'first emitted frame starts at the sync, not at byte 0');
});

test('a non-FLAC stream is passed through instead of buffered forever', () => {
  // Guard against unbounded memory growth if the stream is not FLAC at all.
  const splitter = new FlacFrameSplitter();
  const garbage = Buffer.alloc(600 * 1024, 0x42);
  assert.equal(splitter.push(garbage).length, 0, 'below the cap it is still held');
  const out = splitter.push(Buffer.alloc(600 * 1024, 0x42));
  assert.ok(out.length > 0, 'past the cap the data is released rather than buffered');
});
