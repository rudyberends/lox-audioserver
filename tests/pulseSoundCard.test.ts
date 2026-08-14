import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  frame,
  frameSize,
  PA_CHANNEL_COMMAND,
  TagReader,
  TagWriter,
  type SampleSpec,
} from '../src/adapters/inputs/pulse/pulseProtocol';

/**
 * This server is a sound card that any PulseAudio player can play into, which means speaking the
 * protocol exactly. Everything here is what the wire demands, not what we would have chosen.
 */

test('every value comes back out as it went in', () => {
  const spec: SampleSpec = { format: 'f32le', channels: 2, rate: 44100 };
  const buffer = new TagWriter()
    .u32(3)
    .str('sonn')
    .str(null)
    .bool(true)
    .bool(false)
    .sampleSpec(spec)
    .u32(0xffffffff)
    .usec(1_000_000)
    .s64(-5)
    .build();
  const reader = new TagReader(buffer);
  assert.equal(reader.next(), 3);
  assert.equal(reader.next(), 'sonn');
  assert.equal(reader.next(), null);
  assert.equal(reader.next(), true);
  assert.equal(reader.next(), false);
  assert.deepEqual(reader.next(), spec);
  assert.equal(reader.next(), 0xffffffff);
  assert.equal(reader.next(), 1_000_000);
  assert.equal(reader.next(), -5);
  assert.ok(reader.done);
});

test('a proplist survives the round trip', () => {
  // Clients send their name and a pile of properties this way, and mis-reading one of them throws
  // the whole tagstruct out of step — everything after it would be read at the wrong offset.
  const buffer = new TagWriter()
    .proplist({ 'application.name': 'spotify', 'media.role': 'music' })
    .u32(7)
    .build();
  const reader = new TagReader(buffer);
  assert.deepEqual(reader.next(), { 'application.name': 'spotify', 'media.role': 'music' });
  assert.equal(reader.next(), 7, 'the value after a proplist must still line up');
});

test('an unfamiliar sample format is read as float rather than refused', () => {
  // Soloist decodes to float and asks for it; anything we do not know is far more likely to be a
  // format we have not met than a reason to drop the connection.
  const buffer = Buffer.from([0x61, 99, 2, 0, 0, 0xac, 0x44]);
  assert.deepEqual(new TagReader(buffer).next(), { format: 'f32le', channels: 2, rate: 44100 });
});

test('frames carry their length and channel where the client looks for them', () => {
  const packet = frame(PA_CHANNEL_COMMAND, Buffer.from('abcd'));
  assert.equal(packet.length, 24);
  assert.equal(packet.readUInt32BE(0), 4);
  assert.equal(packet.readUInt32BE(4), PA_CHANNEL_COMMAND);
  assert.equal(packet.subarray(20).toString(), 'abcd');
});

test('a frame is measured in whole samples, so credit never splits one', () => {
  assert.equal(frameSize({ format: 'f32le', channels: 2, rate: 44100 }), 8);
  assert.equal(frameSize({ format: 's24le', channels: 2, rate: 44100 }), 6);
  assert.equal(frameSize({ format: 's16le', channels: 2, rate: 44100 }), 4);
});
