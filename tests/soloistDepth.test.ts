import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SoloistPlaybackService } from '../src/adapters/inputs/spotify/soloist/soloistPlaybackService';

/**
 * Everything Soloist decodes leaves it as float and arrives in 24-bit words, so the pipe cannot
 * say whether a track is a 24-bit master or a 16-bit one padded out — and most of Spotify's
 * catalogue is the latter. The samples can say it, which is what this reads.
 */

const measure = (
  SoloistPlaybackService as unknown as { measureDepth: (pcm: Buffer) => 16 | 24 | undefined }
).measureDepth;

/** Little-endian 24-bit samples from 24-bit values. */
function pcm24(values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 3);
  values.forEach((value, i) => {
    buf[i * 3] = value & 0xff;
    buf[i * 3 + 1] = (value >> 8) & 0xff;
    buf[i * 3 + 2] = (value >> 16) & 0xff;
  });
  return buf;
}

test('a 16-bit master padded into 24-bit words is recognised as 16-bit', () => {
  // Scaling a 16-bit value into 24 bits multiplies it by 256, so the low byte is always zero.
  const samples = [1234, -5678, 32767, -32768, 9999].map((v) => (v << 8) & 0xffffff);
  assert.equal(measure(pcm24(samples)), 16);
});

test('a genuine 24-bit master is recognised as such', () => {
  // One sample with anything in the bottom byte is enough: padding never produces that.
  const samples = [(1234 << 8) | 0x01, (5678 << 8) & 0xffffff, (999 << 8) & 0xffffff];
  assert.equal(measure(pcm24(samples)), 24);
});

test('silence yields no answer rather than a wrong one', () => {
  // A quiet opening has every low byte at zero for a reason that says nothing about the master.
  assert.equal(measure(pcm24([0, 0, 0, 0])), undefined);
  assert.equal(measure(Buffer.alloc(0)), undefined);
});
