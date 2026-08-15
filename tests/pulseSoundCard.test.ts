import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  canCarry,
  converterFor,
  deliveredSpecOf,
  floatToS24,
} from '../src/adapters/inputs/pulse/pulseSoundCard';
import {
  frame,
  FrameSplitter,
  frameSize,
  PA_CHANNEL_COMMAND,
  sampleWidth,
  TagReader,
  TagWriter,
  UNKNOWN_FORMAT,
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

test('an unfamiliar sample format is named as unfamiliar rather than guessed at', () => {
  // It used to be read as float, on the reasoning that float is what a decoder sends. But a format
  // nobody here knows is one byte pattern being described as another, and the engine would play
  // whatever arrived at full scale. Naming it is what lets the stream be refused instead.
  const buffer = Buffer.from([0x61, 99, 2, 0, 0, 0xac, 0x44]);
  assert.deepEqual(new TagReader(buffer).next(), {
    format: UNKNOWN_FORMAT,
    channels: 2,
    rate: 44100,
  });
  assert.ok(!canCarry({ format: UNKNOWN_FORMAT, channels: 2, rate: 44100 }));
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

test('float samples land where they belong in 24-bit words', () => {
  // Silence, both extremes and a half: a wrong scale or the wrong byte order shows up in one of
  // these four, and nowhere else would it be caught before someone heard it.
  const floats = Buffer.alloc(16);
  floats.writeFloatLE(0, 0);
  floats.writeFloatLE(1, 4);
  floats.writeFloatLE(-1, 8);
  floats.writeFloatLE(0.5, 12);
  const pcm = floatToS24(floats);
  assert.equal(pcm.length, 12, 'four samples of three bytes');
  assert.equal(pcm.readIntLE(0, 3), 0);
  assert.equal(pcm.readIntLE(3, 3), 8388607, 'full scale, not wrapped');
  assert.equal(pcm.readIntLE(6, 3), -8388607);
  assert.equal(pcm.readIntLE(9, 3), 4194304, 'half scale is half the number');
});

test('anything past full scale clips rather than wraps', () => {
  // Spotify normalises, and a normalised peak can exceed 1.0. Wrapping would put a click exactly
  // at the loudest moment of a track.
  const floats = Buffer.alloc(8);
  floats.writeFloatLE(1.4, 0);
  floats.writeFloatLE(-2, 4);
  const pcm = floatToS24(floats);
  assert.equal(pcm.readIntLE(0, 3), 8388607);
  assert.equal(pcm.readIntLE(3, 3), -8388607);
});

test('a player that already sends integers is handed on untouched', () => {
  assert.deepEqual(deliveredSpecOf({ format: 's16le', channels: 2, rate: 44100 }), {
    format: 's16le',
    channels: 2,
    rate: 44100,
  });
  assert.equal(deliveredSpecOf({ format: 'f32le', channels: 2, rate: 44100 }).format, 's24le');
});

test('every sample width is the one the format actually occupies', () => {
  // Read off the name instead and `u8` comes out four bytes wide, which makes every credit granted
  // for it four times what the player may send.
  const widths: Array<[string, number]> = [
    ['u8', 1], ['alaw', 1], ['ulaw', 1], ['s16le', 2], ['s16be', 2],
    ['s24le', 3], ['s24be', 3], ['s24_32le', 4], ['s24_32be', 4],
    ['s32le', 4], ['s32be', 4], ['f32le', 4], ['f32be', 4],
  ];
  for (const [format, width] of widths) {
    assert.equal(sampleWidth(format), width, format);
    assert.equal(frameSize({ format, channels: 2, rate: 44100 }), width * 2, format);
  }
});

test('every format a player may ask for lands on one the engine carries', () => {
  // The engine takes four shapes and no others. Anything handed on outside that set is described
  // to it as something it is not, which is heard as noise rather than found as a bug.
  const carried = new Set(['s16le', 's24le', 's32le', 'f32le']);
  for (const format of ['u8', 'alaw', 'ulaw', 's16le', 's16be', 's24le', 's24be',
    's24_32le', 's24_32be', 's32le', 's32be', 'f32le', 'f32be']) {
    const delivered = deliveredSpecOf({ format, channels: 2, rate: 44100 });
    assert.ok(carried.has(delivered.format), `${format} became ${delivered.format}`);
    assert.equal(delivered.rate, 44100, 'nothing here resamples');
    assert.equal(delivered.channels, 2, 'nor remixes');
  }
});

test('a format this card has never heard of is refused rather than guessed at', () => {
  assert.ok(canCarry({ format: 'f32le', channels: 2, rate: 44100 }));
  assert.ok(canCarry({ format: 'ulaw', channels: 1, rate: 8000 }));
  assert.ok(!canCarry({ format: UNKNOWN_FORMAT, channels: 2, rate: 44100 }));
  assert.ok(!canCarry({ format: 'something-new', channels: 2, rate: 44100 }));
  assert.ok(!canCarry({ format: 'f32le', channels: 0, rate: 44100 }), 'no channels is not a stream');
  assert.ok(!canCarry({ format: 'f32le', channels: 2, rate: 2 }), 'nor is two samples a second');
});

test('unsigned 8-bit is recentred rather than carried across as it stands', () => {
  // 128 is silence in an unsigned byte and full negative in a signed word; getting this backwards
  // is a track that plays at full tilt with the sound of a fault.
  const out = converterFor('u8')!(Buffer.from([128, 0, 255]));
  assert.equal(out.readInt16LE(0), 0);
  assert.equal(out.readInt16LE(2), -32768);
  assert.equal(out.readInt16LE(4), 32512);
});

test('the telephone codecs decode to the same numbers ffmpeg gets', () => {
  // Taken from ffmpeg's own decoder, so this is a reference rather than a restatement of the code
  // below it.
  const bytes = Buffer.from([0x00, 0x55, 0x7f, 0x80, 0xd5, 0xff]);
  const alaw = converterFor('alaw')!(bytes);
  const ulaw = converterFor('ulaw')!(bytes);
  const read = (b: Buffer): number[] =>
    Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2));
  assert.deepEqual(read(alaw), [-5504, -8, -848, 5504, 8, 848]);
  assert.deepEqual(read(ulaw), [-32124, -716, 0, 32124, 716, 0]);
});

test('big-endian samples arrive the way round the engine reads them', () => {
  assert.deepEqual([...converterFor('s16be')!(Buffer.from([0x12, 0x34]))], [0x34, 0x12]);
  assert.deepEqual([...converterFor('s24be')!(Buffer.from([0x12, 0x34, 0x56]))], [0x56, 0x34, 0x12]);
  assert.deepEqual(
    [...converterFor('s32be')!(Buffer.from([0x12, 0x34, 0x56, 0x78]))],
    [0x78, 0x56, 0x34, 0x12],
  );
});

test('a swap leaves the buffer it was handed alone', () => {
  // The incoming buffer is the socket's, and it is still being counted after this returns.
  const original = Buffer.from([0x12, 0x34]);
  converterFor('s16be')!(original);
  assert.deepEqual([...original], [0x12, 0x34]);
});

test('24 bits in a 32-bit word come out as 24 bits, not as a quiet 32', () => {
  // Handing the whole word on as `s32le` would be 48 dB down — loud enough to notice and quiet
  // enough to be blamed on everything else first.
  const le = converterFor('s24_32le')!(Buffer.from([0x56, 0x34, 0x12, 0x00]));
  assert.equal(le.readIntLE(0, 3), 0x123456);
  const be = converterFor('s24_32be')!(Buffer.from([0x00, 0x12, 0x34, 0x56]));
  assert.equal(be.readIntLE(0, 3), 0x123456);
});

test('big-endian float is read big-endian', () => {
  const be = Buffer.alloc(4);
  be.writeFloatBE(0.5, 0);
  assert.equal(floatToS24(be, false).readIntLE(0, 3), 4194304);
});

test('a sample that is not a number becomes silence rather than an exception', () => {
  // One NaN out of a decoder would otherwise throw part-way through a buffer and take the
  // connection with it.
  const floats = Buffer.alloc(8);
  floats.writeFloatLE(Number.NaN, 0);
  floats.writeFloatLE(Number.POSITIVE_INFINITY, 4);
  const pcm = floatToS24(floats);
  assert.equal(pcm.readIntLE(0, 3), 0);
  assert.equal(pcm.readIntLE(3, 3), 8388607, 'infinity is simply the loudest it goes');
});

test('a frame split across socket reads is put back together', () => {
  // A write of a second of audio is far larger than one read off the socket, so this is the normal
  // case rather than the awkward one.
  const packet = frame(7, Buffer.from('hello world'));
  const splitter = new FrameSplitter();
  for (const byte of packet) {
    assert.equal(splitter.next(), null, 'nothing is a frame until all of it has arrived');
    splitter.push(Buffer.from([byte]));
  }
  const got = splitter.next();
  assert.equal(got?.channel, 7);
  assert.equal(got?.payload.toString(), 'hello world');
  assert.equal(splitter.next(), null);
});

test('several frames inside one read all come back', () => {
  const splitter = new FrameSplitter();
  splitter.push(Buffer.concat([
    frame(PA_CHANNEL_COMMAND, Buffer.from('one')),
    frame(0, Buffer.from('two')),
    frame(0, Buffer.alloc(0)),
  ]));
  assert.equal(splitter.next()?.payload.toString(), 'one');
  assert.equal(splitter.next()?.payload.toString(), 'two');
  assert.equal(splitter.next()?.payload.length, 0, 'an empty frame is still a frame');
  assert.equal(splitter.next(), null);
});

test('an impossible frame length is refused instead of waited for', () => {
  // The length is four bytes off a socket and nothing vouches for it. Waiting for four gigabytes
  // that will never arrive holds on to everything that arrives meanwhile.
  const splitter = new FrameSplitter();
  const header = Buffer.alloc(20);
  header.writeUInt32BE(0xffffffff, 0);
  splitter.push(header);
  assert.throws(() => splitter.next(), /past anything a player sends/);
});

test('a volume comes back as the levels that were set, not as a count of them', () => {
  // Answering a client with the volume it asked for is the only way its own setting does not
  // appear to vanish the moment it reads it back.
  const buffer = new TagWriter().cvolumeOf([0x8000, 0x4000]).u32(9).build();
  const reader = new TagReader(buffer);
  assert.deepEqual(reader.next(), [0x8000, 0x4000]);
  assert.equal(reader.next(), 9, 'and the value after it still lines up');
});
