import assert from 'node:assert/strict';
import { test } from './testHarness';
import { parseRange } from '../src/adapters/subsonic/subsonicStreamHandler';

// Byte-range support is what lets a Subsonic client seek in a local file — the
// thing the DLNA track endpoint cannot offer, because it transcodes live.

test('subsonic range: no header means serve the whole file', () => {
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange('', 1000), null);
});

test('subsonic range: an explicit start-end range is honoured', () => {
  assert.deepEqual(parseRange('bytes=100-199', 1000), { start: 100, end: 199 });
});

test('subsonic range: an open-ended range runs to the last byte', () => {
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
});

test('subsonic range: a suffix range takes the final bytes', () => {
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  // A suffix longer than the file clamps to the whole file rather than going negative.
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
});

test('subsonic range: an end past the file is clamped', () => {
  assert.deepEqual(parseRange('bytes=900-99999', 1000), { start: 900, end: 999 });
});

test('subsonic range: a start past the file is unsatisfiable', () => {
  assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=5000-6000', 1000), 'unsatisfiable');
});

test('subsonic range: an inverted range is unsatisfiable', () => {
  assert.equal(parseRange('bytes=500-100', 1000), 'unsatisfiable');
});

test('subsonic range: unparseable or multi-range headers fall back to the whole file', () => {
  // Serving the whole body is a legal response to a range request; guessing at
  // multipart/byteranges would be worse.
  assert.equal(parseRange('bytes=0-99,200-299', 1000), null);
  assert.equal(parseRange('items=0-99', 1000), null);
  assert.equal(parseRange('bytes=abc-def', 1000), null);
  assert.equal(parseRange('bytes=-', 1000), null);
});

test('subsonic range: an empty file has no satisfiable range', () => {
  assert.equal(parseRange('bytes=0-10', 0), null);
});

test('subsonic range: a header array uses the first value', () => {
  assert.deepEqual(parseRange(['bytes=10-20', 'bytes=30-40'], 1000), { start: 10, end: 20 });
});
