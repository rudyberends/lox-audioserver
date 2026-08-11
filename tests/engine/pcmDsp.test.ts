import assert from 'node:assert/strict';
import { test } from '../testHarness';
import { PcmDspStage, bandsAreActive, type PcmDspBitDepth } from '../../src/engine/pcmDsp';

const SR = 44100;

/** Interleaved f32le, the format the engine-DSP decoder emits. */
function f32(frames: Float64Array[], channels = 2): Buffer {
  const buf = Buffer.allocUnsafe(frames.length * channels * 4);
  frames.forEach((frame, index) => {
    for (let channel = 0; channel < channels; channel += 1) {
      buf.writeFloatLE(frame[channel] ?? 0, (index * channels + channel) * 4);
    }
  });
  return buf;
}

function stereo(samples: number[]): Buffer {
  return f32(samples.map((value) => Float64Array.of(value, value)));
}

async function collect(
  stage: PcmDspStage,
  input: Buffer,
  chunkBytes = 4096,
  midway?: () => void,
): Promise<Buffer> {
  const out: Buffer[] = [];
  stage.on('data', (chunk: Buffer) => out.push(chunk));
  const done = new Promise<void>((resolve) => stage.on('end', () => resolve()));
  const half = Math.floor(input.length / 2);
  let fired = false;
  for (let offset = 0; offset < input.length; offset += chunkBytes) {
    if (midway && !fired && offset >= half) {
      midway();
      fired = true;
    }
    stage.write(input.subarray(offset, Math.min(offset + chunkBytes, input.length)));
  }
  stage.end();
  await done;
  return Buffer.concat(out);
}

function makeStage(
  bands: number[] | null,
  options: { bitDepth?: PcmDspBitDepth; gainDb?: number; rampFrames?: number } = {},
): PcmDspStage {
  return new PcmDspStage({
    sampleRate: SR,
    channels: 2,
    bitDepth: options.bitDepth ?? 16,
    ...(options.gainDb === undefined ? {} : { gainDb: options.gainDb }),
    ...(options.rampFrames === undefined ? {} : { rampFrames: options.rampFrames }),
    bands,
  });
}

test('flat bands are a pure requantisation, within one dither step', async () => {
  const values = Array.from({ length: 2048 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR));
  const out = await collect(makeStage(null), stereo(values));
  assert.equal(out.length, values.length * 2 * 2);
  for (let i = 0; i < values.length; i += 1) {
    const expected = Math.round(values[i]! * 32768);
    // TPDF dither spans +/-1 LSB, so anything further off is the signal being altered.
    assert.ok(Math.abs(out.readInt16LE(i * 4) - expected) <= 2, `sample ${i}`);
  }
});

test('gain is applied in dB and does not depend on the equalizer', async () => {
  const values = Array.from({ length: 512 }, () => 0.5);
  const out = await collect(makeStage(null, { gainDb: -6.020599913 }), stereo(values));
  // -6.02 dB is exactly half, so 0.5 becomes 0.25 of full scale.
  assert.ok(Math.abs(out.readInt16LE(200 * 4) - Math.round(0.25 * 32768)) <= 2);
});

test('a boosted band has the gain it advertises at its centre frequency', async () => {
  // Measure the response the way a measurement rig would: feed an impulse, then evaluate the transfer
  // function at the band centre. This is what makes the coefficients verifiable rather than plausible.
  const length = 16384;
  const impulse = Array.from({ length }, (_, i) => (i === 0 ? 0.25 : 0));
  const bands = [0, 0, 0, 0, 0, 6, 0, 0, 0, 0]; // +6 dB at 1 kHz
  const out = await collect(makeStage(bands, { bitDepth: 32 }), stereo(impulse));

  const gainAt = (frequency: number): number => {
    // Goertzel-style single-bin DFT over the impulse response.
    let real = 0;
    let imaginary = 0;
    for (let i = 0; i < length; i += 1) {
      const sample = out.readInt32LE(i * 8) / 2147483648 / 0.25;
      const angle = (-2 * Math.PI * frequency * i) / SR;
      real += sample * Math.cos(angle);
      imaginary += sample * Math.sin(angle);
    }
    return Math.sqrt(real * real + imaginary * imaginary);
  };

  const atCentre = 20 * Math.log10(gainAt(1000));
  const wellBelow = 20 * Math.log10(gainAt(50));
  assert.ok(Math.abs(atCentre - 6) < 0.3, `expected +6 dB at 1 kHz, measured ${atCentre.toFixed(2)}`);
  assert.ok(Math.abs(wellBelow) < 0.5, `expected no lift at 50 Hz, measured ${wellBelow.toFixed(2)}`);
});

test('output is independent of how the decoder chunks its stdout', async () => {
  const values = Array.from({ length: 5000 }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 220 * i) / SR));
  const bands = [3, 0, -3, 0, 3, 0, -3, 0, 3, 0];
  const evenly = await collect(makeStage(bands), stereo(values), 4096);
  const awkwardly = await collect(makeStage(bands), stereo(values), 1021);
  assert.deepEqual(evenly, awkwardly, 'a partial frame must be carried, not dropped or padded');
});

test('a band change is ramped, so the switch is inaudible', async () => {
  // A 40 Hz tone against the 31 Hz band is the worst case: that biquad holds the most state, and
  // swapping its coefficients under it steps the output. Measured on the raw stage: a hard swap jumps
  // 1390 LSB where the signal's own largest step is 31.
  const length = 40000;
  const values = Array.from({ length }, (_, i) => 0.7 * Math.sin((2 * Math.PI * 40 * i) / SR));
  const from = [6, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const to = [-6, 0, 0, 0, 0, 0, 0, 0, 0, 0];

  const largestStep = (buf: Buffer, fromByte: number, toByte: number): number => {
    let worst = 0;
    for (let i = fromByte + 4; i < toByte; i += 4) {
      worst = Math.max(worst, Math.abs(buf.readInt16LE(i) - buf.readInt16LE(i - 4)));
    }
    return worst;
  };

  const ramped = makeStage(from, { rampFrames: 512 });
  const rampedOut = await collect(ramped, stereo(values), 4096, () => ramped.setBands(to));
  const stepped = makeStage(from, { rampFrames: 1 });
  const steppedOut = await collect(stepped, stereo(values), 4096, () => stepped.setBands(to));

  const middle = Math.floor(length / 2) * 4;
  const baseline = largestStep(rampedOut, 4000 * 4, 8000 * 4);
  const atRamp = largestStep(rampedOut, middle - 400, middle + 8000);
  const atStep = largestStep(steppedOut, middle - 400, middle + 8000);
  assert.ok(atRamp <= baseline * 1.2, `ramped switch stepped ${atRamp} against a baseline of ${baseline}`);
  assert.ok(atStep > baseline * 5, `expected the unramped swap to click; it stepped ${atStep}`);
});

test('setBands reports whether anything changed', () => {
  const stage = makeStage([0, 3, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(stage.setBands([0, 3, 0, 0, 0, 0, 0, 0, 0, 0]), false, 'the same curve is not a change');
  assert.equal(stage.setBands([0, 4, 0, 0, 0, 0, 0, 0, 0, 0]), true);
  assert.equal(stage.setBands(null), true);
  stage.destroy();
});

test('24-bit output is packed into three bytes per sample', async () => {
  const values = Array.from({ length: 64 }, () => 0.25);
  const out = await collect(makeStage(null, { bitDepth: 24 }), stereo(values));
  assert.equal(out.length, values.length * 2 * 3, 's24le is packed, not padded into four bytes');
  assert.ok(Math.abs(out.readIntLE(30 * 6, 3) - Math.round(0.25 * 8388608)) <= 1);
});

test('bandsAreActive ignores the noise around zero', () => {
  assert.equal(bandsAreActive(null), false);
  assert.equal(bandsAreActive([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), false);
  assert.equal(bandsAreActive([0, 0, 0, 0.01, 0, 0, 0, 0, 0, 0]), false, 'below the audible floor');
  assert.equal(bandsAreActive([0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0]), true);
});
