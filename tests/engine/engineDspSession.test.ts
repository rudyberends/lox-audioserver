import { zoneSessionKey } from '../../src/ports/types/SessionKey';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from '../testHarness';
import { AudioSession, type OutputProfile } from '../../src/engine/audioSession';
import type { AudioOutputSettings } from '../../src/engine/audioFormat';

const SR = 44100;
const OUTPUT: AudioOutputSettings = {
  sampleRate: SR,
  channels: 2,
  pcmBitDepth: 16,
  mp3Bitrate: '256k',
  prebufferBytes: 0,
  httpProfile: 'default',
  httpFallbackSeconds: 12 * 3600,
  fixedGainDb: 0,
  httpIcyEnabled: false,
  httpIcyInterval: 16384,
  httpIcyName: 'test',
};
const EQ = [0, 0, 0, 0, 0, 6, 0, 0, 0, 0];

/**
 * The suite stubs every ffmpeg spawn, so the decoder here is a fake whose stdout we drive ourselves.
 * That is the useful half anyway: what ffmpeg does with a file is verified through the argument tests,
 * while everything downstream of its stdout — our stage, the aligner, the buffer, the fanout — is ours.
 */
function feedDecoder(session: AudioSession, frames: number): void {
  const stdout = session.pipeline.decoder?.stdout as unknown as PassThrough | undefined;
  assert.ok(stdout, 'the engine-DSP topology spawns a decoder');
  const buf = Buffer.allocUnsafe(frames * 2 * 4);
  for (let i = 0; i < frames; i += 1) {
    const value = 0.4 * Math.sin((2 * Math.PI * 440 * i) / SR);
    buf.writeFloatLE(value, i * 8);
    buf.writeFloatLE(value, i * 8 + 4);
  }
  stdout.write(buf);
}

function makeSession(profile: OutputProfile, bands: number[] | null): AudioSession {
  return new AudioSession(
    zoneSessionKey(1),
    { kind: 'file', path: '/music/track.flac', realTime: false },
    profile,
    () => {},
    OUTPUT,
    bands,
    false, // crossfade off: the engine-DSP topology is the default shape
  );
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

test('a PCM zone with EQ runs the engine-DSP topology and needs no encoder', async () => {
  const session = makeSession('pcm', EQ);
  session.start();

  assert.equal(session.engineDspMode, true, 'the DSP is ours, not a filter graph');
  assert.ok(session.dsp, 'the stage exists');
  assert.equal(session.process, undefined, 'a PCM profile needs no second ffmpeg');

  const subscriber = session.createSubscriber({ primeWithBuffer: false, label: 'test' });
  assert.ok(subscriber, 'subscribers attach to a process-less session too');
  let bytes = 0;
  subscriber!.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
  });

  feedDecoder(session, 4096);
  assert.equal(await session.waitForFirstChunk(1000), true, 'audio reached the output');
  await settle();
  // Float in, 16-bit stereo out: half the bytes of the bus.
  assert.equal(bytes, 4096 * 2 * 2);
  session.stop(true);
});

test('an EQ change on that zone is applied without restarting anything', async () => {
  const session = makeSession('pcm', EQ);
  session.start();
  const stage = session.dsp;
  const decoder = session.pipeline.decoder;
  const subscriber = session.createSubscriber({ primeWithBuffer: false, label: 'test' });
  let bytes = 0;
  subscriber!.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
  });
  feedDecoder(session, 1024);
  assert.equal(await session.waitForFirstChunk(1000), true);
  await settle();
  const bytesBeforeChange = bytes;

  session.restartForEqualizer([6, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  feedDecoder(session, 1024);
  await settle();
  const bytesAfterChange = bytes - bytesBeforeChange;

  assert.equal(session.dsp, stage, 'the same stage kept running — no respawn');
  assert.equal(session.pipeline.decoder, decoder, 'and the same decoder, so nothing was re-seeked');
  assert.equal(session.engineDspMode, true);
  assert.deepEqual(session.equalizerBands, [6, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(bytesAfterChange, 1024 * 2 * 2, 'audio kept flowing across the change');
  session.stop(true);
});

test('turning the EQ off entirely respawns, so passthrough can be regained', async () => {
  const session = makeSession('pcm', EQ);
  session.start();
  assert.ok(session.dsp);
  session.restartForEqualizer(null);
  // The respawn runs on the decoder's exit; what matters here is that it was asked to stop rather
  // than the bands being applied to a stage that would keep a needless conversion alive.
  assert.deepEqual(session.equalizerBands, null);
  session.stop(true);
});

test('a codec zone with EQ keeps an encoder, fed by our stage', async () => {
  const session = makeSession('flac', EQ);
  session.start();
  assert.equal(session.engineDspMode, true);
  assert.ok(session.process, 'flac still needs ffmpeg to encode');
  assert.equal(session.outputReadable, undefined, 'the encoder owns the output side');

  const encoderInput: Buffer[] = [];
  (session.process!.stdin as unknown as PassThrough).on('data', (chunk: Buffer) => {
    encoderInput.push(chunk);
  });
  feedDecoder(session, 512);
  await settle();

  const total = encoderInput.reduce((sum, chunk) => sum + chunk.length, 0);
  assert.equal(total, 512 * 2 * 2, 'the encoder is fed our finished 16-bit PCM, not float');
  session.stop(true);
});

test('a lossy encoder is fed float, not requantised integers', async () => {
  const session = makeSession('mp3', EQ);
  session.start();
  assert.ok(session.process);
  const received: Buffer[] = [];
  (session.process!.stdin as unknown as PassThrough).on('data', (chunk: Buffer) => {
    received.push(chunk);
  });
  feedDecoder(session, 512);
  await settle();
  const total = received.reduce((sum, chunk) => sum + chunk.length, 0);
  // Four bytes per sample: the float came through untouched by a pointless 16-bit round trip.
  assert.equal(total, 512 * 2 * 4);
  session.stop(true);
});

/** A live producer, the shape librespot and line-in hand us. */
function pipeSession(bands: number[] | null): { session: AudioSession; stream: PassThrough } {
  const stream = new PassThrough();
  const session = new AudioSession(
    zoneSessionKey(1),
    {
      kind: 'pipe',
      path: 'librespot',
      stream,
      format: 's16le',
      sampleRate: SR,
      channels: 2,
    },
    'pcm',
    () => {},
    OUTPUT,
    bands,
    false,
  );
  return { session, stream };
}

test('a format-matched live source with EQ no longer takes the passthrough', async () => {
  // It used to: `canDirectPassthrough` compares formats only, so a Spotify zone whose format happened to
  // match the output silently played with its equalizer ignored.
  const { session, stream } = pipeSession(EQ);
  session.start();
  assert.equal(session.directPipeMode, false, 'a passthrough cannot apply an equalizer');
  assert.equal(session.engineDspMode, true);
  assert.ok(session.dsp);

  const decoderInput: Buffer[] = [];
  (session.pipeline.decoder!.stdin as unknown as PassThrough).on('data', (chunk: Buffer) => {
    decoderInput.push(chunk);
  });
  stream.write(Buffer.alloc(4096));
  await settle();
  assert.ok(
    decoderInput.reduce((sum, chunk) => sum + chunk.length, 0) > 0,
    'the producer feeds the decoder’s stdin',
  );
  session.stop(true);
  stream.end();
});

test('a matched live source without EQ still gets the ffmpeg-free passthrough', () => {
  const { session, stream } = pipeSession(null);
  session.start();
  assert.equal(session.directPipeMode, true, 'nothing to do means no ffmpeg at all');
  assert.equal(session.engineDspMode, false);
  session.stop(true);
  stream.end();
});

test('switching the EQ on during a passthrough swaps the topology instead of doing nothing', async () => {
  // A passthrough has no filter to change and no process to kill, so the restart used to return early
  // and the slider did nothing at all until the next track.
  const { session, stream } = pipeSession(null);
  session.start();
  assert.equal(session.directPipeMode, true);

  session.restartForEqualizer(EQ);
  await settle();

  assert.equal(session.engineDspMode, true, 'the equalizer brought a stage with it');
  assert.equal(session.directPipeMode, false);
  assert.ok(session.dsp);
  assert.ok(session.dsp!.headroomDb < 0, 'and the headroom that its boost needs');
  session.stop(true);
  stream.end();
});

test('without DSP the session keeps the untouched single-stage path', () => {
  // The point of gating on "is there DSP at all": a passthrough session must not gain a stage, a float
  // bus or an extra hop just because the topology exists.
  const session = makeSession('pcm', null);
  session.start();
  assert.equal(session.engineDspMode, false);
  assert.equal(session.dsp, undefined);
  assert.ok(session.process, 'one ffmpeg, exactly as before');
  session.stop(true);
});

test('a fixed output gain alone is enough to own the chain', () => {
  // Spotify's loudness normalisation and a per-output trim are the same kind of stage as the EQ, and
  // they must not be left on a command line that cannot change.
  const session = new AudioSession(
    zoneSessionKey(1),
    { kind: 'url', url: 'https://x/y.m4a', gainDb: -3.5 },
    'pcm',
    () => {},
    OUTPUT,
    null,
    false,
  );
  session.start();
  assert.equal(session.engineDspMode, true);
  assert.ok(session.dsp);
  session.stop(true);
});

/**
 * A child process exits before Node has read what it wrote — the kernel still holds the tail. Ending
 * the DSP stage from the decoder's exit handler therefore raced `decoder.stdout.pipe(dsp)`, and lost
 * every time: the queued chunk landed on an ended writable, the stage raised
 * ERR_STREAM_WRITE_AFTER_END, and the error handler answered that by tearing the session down. The
 * rest of the track went with it — measured at ~5 s off the end of every Spotify track, on Sonos and
 * on DLNA alike, followed by silence until the zone clock ended the track for real (#322).
 */
test('a decoder that exits while its pipe is still draining keeps the tail (#322)', async () => {
  const session = makeSession('pcm', EQ);
  session.start();

  const subscriber = session.createSubscriber({ primeWithBuffer: false, label: 'test' });
  assert.ok(subscriber);
  let bytes = 0;
  subscriber!.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
  });

  feedDecoder(session, 1024);
  await settle();
  const beforeTail = bytes;
  assert.ok(beforeTail > 0, 'the session is running');

  // The tail and the exit right behind it: written by the decoder, not yet read by us.
  feedDecoder(session, 1024);
  (session.pipeline.decoder as unknown as EventEmitter).emit('exit', 0, null);
  await settle();

  assert.equal(bytes, beforeTail + 1024 * 2 * 2, 'every byte written before the exit still arrives');
  assert.equal(session.engineDspMode, true, 'and the session is not torn down on the way');
  session.stop(true);
});

test('and when that pipe really does drain, the stage still ends the session', async () => {
  const session = makeSession('pcm', EQ);
  session.start();

  const subscriber = session.createSubscriber({ primeWithBuffer: false, label: 'test' });
  subscriber!.on('data', () => {});
  const stdout = session.pipeline.decoder?.stdout as unknown as PassThrough;

  feedDecoder(session, 1024);
  (session.pipeline.decoder as unknown as EventEmitter).emit('exit', 0, null);
  // What the exit no longer does, stdout's own end still must: nothing else would ever finish the
  // stage, and a zone whose session never tears down never starts the next track.
  stdout.end();
  await settle();

  assert.equal(session.engineDspMode, false, 'the drained pipe ends the stage, which ends the session');
});
