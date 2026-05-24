import assert from 'node:assert/strict';
import { test } from '../testHarness';
import { codecPolicyForProfile } from '../../src/engine/codecPolicy';

test('codecPolicyForProfile returns FLAC policy for flac', () => {
  const policy = codecPolicyForProfile('flac');
  const flacChunk = Buffer.concat([Buffer.from('fLaC', 'ascii'), Buffer.alloc(60)]);
  assert.equal(policy.startsWithHeader(flacChunk), true);
});

test('FLAC policy returns null for non-FLAC chunk', () => {
  const policy = codecPolicyForProfile('flac');
  assert.equal(policy.startsWithHeader(Buffer.from('NOPE', 'ascii')), false);
  assert.equal(policy.captureHeader(Buffer.from('NOPE', 'ascii')), null);
});

test('FLAC policy captures STREAMINFO and sets is_last bit', () => {
  // fLaC (4 bytes) + block header (1 byte type + 3 bytes length) + 34 bytes STREAMINFO
  const block = Buffer.alloc(38);
  block[0] = 0x66; block[1] = 0x4c; block[2] = 0x61; block[3] = 0x43; // "fLaC"
  block[4] = 0x00; // type=STREAMINFO, is_last bit NOT set
  block[5] = 0x00; block[6] = 0x00; block[7] = 0x22; // length=34
  const fullChunk = Buffer.concat([block, Buffer.alloc(200)]);

  const policy = codecPolicyForProfile('flac');
  const header = policy.captureHeader(fullChunk);
  assert.ok(header, 'header captured');
  // STREAMINFO data length 34 + 4 (fLaC) + 4 (block header) = 42 bytes
  assert.equal(header.length, 42);
  // is_last bit (0x80) set on block-header byte
  assert.equal((header[4]! & 0x80) !== 0, true, 'is_last bit set');
});

test('Non-flac profile returns the null policy', () => {
  const policy = codecPolicyForProfile('mp3');
  const flacChunk = Buffer.concat([Buffer.from('fLaC', 'ascii'), Buffer.alloc(60)]);
  assert.equal(policy.startsWithHeader(flacChunk), false);
  assert.equal(policy.captureHeader(flacChunk), null);
});
