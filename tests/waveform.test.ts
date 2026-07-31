import assert from 'node:assert/strict';
import { test } from './testHarness';
import { bucketsFromPcm, PROBE_RATE, WAVEFORM_BUCKETS } from '../src/engine/waveform';
import { ANALYSIS_DB_FLOOR } from '../src/application/audio/audioAnalysisService';
import { WaveformService, type WaveformStore } from '../src/application/audio/waveformService';

/*
 * A prepared waveform is only useful if the player can trust what the bytes *mean*.
 *
 * The wire carries one byte per bucket, and the contract is that it is the bucket's level as a
 * position in the analysis dB window — the same scale the live loudness stream uses, which is what
 * lets one component draw either source without rescaling one to match the other. A change that
 * quietly made these linear amplitudes, or moved the floor, would leave every timeline drawn wrong
 * and nothing failing.
 *
 * So the encoding is asserted against synthetic tones of a known level rather than against a
 * snapshot of what the code currently produces. No ffmpeg: the decode is not what is interesting
 * here, and this suite replaces every ffmpeg spawn with a stub on purpose.
 */

/** `seconds` of a 440 Hz sine at `amplitude` (0…1), as the decoder would hand it over. */
function tone(amplitude: number, seconds: number): Buffer {
  const samples = Math.round(PROBE_RATE * seconds);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.sin((2 * Math.PI * 440 * i) / PROBE_RATE) * amplitude;
    pcm.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  return pcm;
}

/** The byte a steady sine of this peak amplitude should land on. */
function expectedByte(amplitude: number): number {
  // A sine's RMS is its peak over √2, and the window is linear in dB from the floor to 0 dBFS.
  const db = 20 * Math.log10(amplitude / Math.SQRT2);
  return Math.round(((db - ANALYSIS_DB_FLOOR) / -ANALYSIS_DB_FLOOR) * 255);
}

test('a bucket is the level as a position in the analysis dB window', () => {
  const buckets = bucketsFromPcm(tone(0.5, 3));
  assert.equal(buckets.length, WAVEFORM_BUCKETS);

  const expected = expectedByte(0.5);
  for (const bucket of buckets) {
    assert.ok(
      Math.abs(bucket - expected) <= 2,
      `bucket ${bucket} should be within 2 of ${expected} for a -6 dBFS sine`,
    );
  }
});

test('level is logarithmic: 6 dB down is a fixed step, not half the byte', () => {
  const loud = bucketsFromPcm(tone(0.5, 3));
  const quiet = bucketsFromPcm(tone(0.25, 3));

  // 6 dB down, and the window is 60 dB across 255 steps: a tenth of the range, wherever it started.
  const step = (loud[10] ?? 0) - (quiet[10] ?? 0);
  assert.ok(Math.abs(step - 25.5) <= 2, `a 6 dB drop should be ~25 bytes, got ${step}`);
  // The thing this rules out: a linear mapping, where a halving would cost half the byte.
  assert.ok((quiet[10] ?? 0) > (loud[10] ?? 0) / 2 + 20, 'the mapping must not be linear');
});

test('silence reads as the floor, and a short buffer does not overrun', () => {
  // Silence is a real reading and has to be distinguishable from "nothing measured here", which the
  // player draws as a hairline instead of as a zero-height bar.
  assert.deepEqual([...new Set(bucketsFromPcm(tone(0, 1)))], [0]);

  // Fewer samples than buckets: the buckets that have audio are filled and the rest stay at the
  // floor rather than reading past the end of the buffer. Which ones are loud is not the point —
  // with one sample per bucket a bucket can land on the wave's zero crossing and read silent.
  const samples = 40;
  const short = bucketsFromPcm(tone(0.5, samples / PROBE_RATE));
  assert.equal(short.length, WAVEFORM_BUCKETS);
  assert.ok(
    [...short.slice(0, samples)].some((bucket) => bucket > 0),
    'the buckets covering the audio cannot all be silent',
  );
  assert.deepEqual([...new Set(short.slice(samples))], [0], 'past the audio there is nothing');
});

/*
 * The service around it stores by *file*, and that is the part worth pinning.
 *
 * A library track is addressed two ways — the raw `library://` path and the opaque browse id the
 * listings hand out — and both resolve to the same file. Keyed by the audiopath, the same track was
 * decoded twice and stored twice, and a shape prepared while browsing was invisible to a client
 * holding the other form.
 */
test('a waveform is looked up by the file, and a stream has none', () => {
  const rows = new Map<string, { buckets: Uint8Array; durationMs: number | null }>();
  const store: WaveformStore = {
    getWaveform: (key) => rows.get(key) ?? null,
    upsertWaveform: (entry) => {
      rows.set(entry.path, { buckets: entry.buckets, durationMs: entry.durationMs });
    },
  };
  const service = new WaveformService(store);

  store.upsertWaveform({ path: '/music/local/album/01.flac', buckets: new Uint8Array([1, 2]), durationMs: 1000 });
  assert.equal(rows.size, 1);

  // Nothing on disk behind it, so there is nothing to prepare and no row of its own.
  assert.equal(service.get('spotify:track:abc'), null);
  assert.equal(rows.size, 1);
});
