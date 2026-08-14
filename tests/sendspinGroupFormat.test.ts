import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  allDeclareFormat,
  declaresFormat,
} from '../src/adapters/outputs/sendspin/sendspinFormatMatch';
import type { SendspinDeclaredFormat } from '../src/application/outputs/sendspinGroupController';

/**
 * Which format a group plays at.
 *
 * A Sendspin member never negotiates for itself — the group controller hands it the leader's
 * stream verbatim — so the leader used to refuse to follow its source at all while grouped,
 * and two rooms that each play 44.1 kHz untouched on their own were resampled to 48 kHz
 * purely for being grouped. The constraint is that the group shares *one* format, not that it
 * be the leader's own negotiated one; these fix which.
 */

const AAC_44_16 = { sampleRate: 44100, bitDepth: 16, channels: 2 };

/** A client that plays anything, as a modern sonn-client declares it. */
const WIDE: SendspinDeclaredFormat[] = [
  { codec: 'pcm', sample_rate: 44100, bit_depth: 16, channels: 2 },
  { codec: 'pcm', sample_rate: 48000, bit_depth: 16, channels: 2 },
  { codec: 'pcm', sample_rate: 96000, bit_depth: 24, channels: 2 },
];

/** An amp wired at one rate and one rate only. */
const FIXED_48: SendspinDeclaredFormat[] = [
  { codec: 'pcm', sample_rate: 48000, bit_depth: 16, channels: 2 },
  { codec: 'pcm', sample_rate: 48000, bit_depth: 24, channels: 2 },
];

test('the codec of a declared entry is not part of the match', () => {
  // Members are always fed PCM, so an OPUS-only entry at the right rate still says the
  // device renders those samples.
  const opusOnly: SendspinDeclaredFormat[] = [
    { codec: 'opus', sample_rate: 44100, bit_depth: 16, channels: 2 },
  ];
  assert.equal(declaresFormat(opusOnly, AAC_44_16), true);
});

test('a rate, depth or channel count the client never listed is not a match', () => {
  assert.equal(declaresFormat(FIXED_48, AAC_44_16), false);
  assert.equal(declaresFormat(WIDE, { ...AAC_44_16, bitDepth: 32 }), false);
  assert.equal(declaresFormat(WIDE, { ...AAC_44_16, channels: 6 }), false);
});

test('a group of clients that all take the source rate follows the source', () => {
  // The reported case: both rooms declare 44.1/16, so grouping them must not cost a resample.
  assert.equal(allDeclareFormat([WIDE, WIDE], AAC_44_16), true);
});

test('one member that cannot take the rate holds the whole group back', () => {
  // It would be handed 44.1 kHz frames it never said it could render.
  assert.equal(allDeclareFormat([WIDE, FIXED_48], AAC_44_16), false);
  assert.equal(allDeclareFormat([WIDE, FIXED_48], { ...AAC_44_16, sampleRate: 48000 }), true);
});

test('a member that declares nothing counts as a no', () => {
  // An older node-sendspin has no supported_formats getter, so its list arrives empty.
  // Silence is not consent: the leader stays on its negotiated format, as it did before
  // members had a say at all.
  assert.equal(allDeclareFormat([WIDE, []], AAC_44_16), false);
});

test('a zone that leads nobody is unconstrained', () => {
  // No member lists at all — solo, or a group whose members are all disconnected.
  assert.equal(allDeclareFormat([], AAC_44_16), true);
});
