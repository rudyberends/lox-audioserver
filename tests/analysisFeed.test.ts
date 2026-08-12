import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { test } from './testHarness';
import {
  EngineAnalysisFeed,
  type AnalysisDecoder,
  type AnalysisDecoderSpec,
} from '../src/application/audio/analysisFeed';
import type { EngineSessionStats } from '../src/ports/EnginePort';
import type { OutputProfile } from '../src/ports/EngineTypes';

function stats(overrides: Partial<EngineSessionStats> & { profile: OutputProfile }): EngineSessionStats {
  return {
    startedAt: 1,
    sampleRate: 44100,
    channels: 2,
    pcmBitDepth: 16,
    bps: null,
    bitPerfect: false,
    dspApplied: false,
    bufferedBytes: 0,
    totalBytes: 0,
    lastUpdated: null,
    subscribers: 1,
    restarts: 0,
    lastError: null,
    lastErrorAt: null,
    lastStderr: null,
    lastStderrAt: null,
    lastExitCode: null,
    lastExitSignal: null,
    lastExitAt: null,
    subscriberDrops: 0,
    lastSubscriberDropAt: null,
    ...overrides,
  };
}

type FakeStdin = { writableLength: number; written: Buffer[] };

type Harness = {
  feed: EngineAnalysisFeed;
  createStreamCalls: Array<{ profile?: OutputProfile; primeWithBuffer?: boolean; label?: string }>;
  decoders: Array<{ spec: AnalysisDecoderSpec; terminated: boolean; sink: PassThrough; stdin: FakeStdin }>;
  pushed: Array<{ zoneId: number; pcm: Buffer }>;
  streams: PassThrough[];
};

function harness(sessions: EngineSessionStats[]): Harness {
  const createStreamCalls: Harness['createStreamCalls'] = [];
  const decoders: Harness['decoders'] = [];
  const pushed: Harness['pushed'] = [];
  const streams: PassThrough[] = [];
  const feed = new EngineAnalysisFeed({
    engine: {
      getSessionStats: () => sessions,
      createStream: (_key, profile, options) => {
        createStreamCalls.push({ profile, ...options });
        const stream = new PassThrough();
        streams.push(stream);
        return stream;
      },
    },
    sessionKey: (zoneId) => zoneId as never,
    // Teardown is asserted directly here, so skip the grace period a live consumer relies on.
    releaseGraceMs: 0,
    push: (zoneId, pcm) => pushed.push({ zoneId, pcm }),
    createDecoder: (spec) => {
      const sink = new PassThrough();
      // A stand-in for ffmpeg's stdin whose backlog the test controls, since the whole point of the
      // write loop is what it does when the decoder is behind.
      const stdin: FakeStdin = { writableLength: 0, written: [] };
      const entry = { spec, terminated: false, sink, stdin };
      decoders.push(entry);
      const decoder: AnalysisDecoder = {
        stdin: {
          get writableLength() {
            return stdin.writableLength;
          },
          write: (chunk: Buffer) => {
            stdin.written.push(chunk);
            return true;
          },
          on: () => undefined,
        } as unknown as Writable,
        detach: () => undefined,
        terminate: () => {
          entry.terminated = true;
        },
      };
      return decoder;
    },
  });
  return { feed, createStreamCalls, decoders, pushed, streams };
}

test('the analysis feed only ever subscribes — it never asks the engine to change the stream', () => {
  const h = harness([stats({ profile: 'flac', sampleRate: 96000, pcmBitDepth: 24 })]);
  h.feed.ensure(5);

  // The one and only interaction with the engine is a subscriber on the profile that is already
  // playing. Nothing here can reach the producer, so a bit-perfect session stays bit-perfect.
  assert.deepEqual(h.createStreamCalls, [
    { profile: 'flac', primeWithBuffer: false, label: 'analysis' },
  ]);
  // The decode has to match the session's own format or the analyzer reads the bytes wrong.
  assert.equal(h.decoders[0]?.spec.sampleRate, 96000);
  assert.equal(h.decoders[0]?.spec.channels, 2);
  assert.equal(h.decoders[0]?.spec.bitDepth, 24);

  h.feed.release(5);
  assert.equal(h.decoders[0]?.terminated, true);
  assert.equal(h.streams[0]?.destroyed, true);
});

test('a PCM session is left alone — the engine already pushes those frames', () => {
  const h = harness([stats({ profile: 'pcm' })]);
  h.feed.ensure(1);
  assert.deepEqual(h.createStreamCalls, []);
  assert.equal(h.decoders.length, 0);
  h.feed.release(1);
});

test('a PCM session alongside an encoded one still suppresses the tap (no double frames)', () => {
  const h = harness([stats({ profile: 'mp3' }), stats({ profile: 'pcm' })]);
  h.feed.ensure(2);
  assert.deepEqual(h.createStreamCalls, []);
  h.feed.release(2);
});

test('a session nobody is listening to is not tapped, so an idle producer is not resumed', () => {
  const h = harness([stats({ profile: 'mp3', subscribers: 0 })]);
  h.feed.ensure(3);
  assert.deepEqual(h.createStreamCalls, []);
  h.feed.release(3);
});

test('decoded PCM reaches the analysis service for the right zone', () => {
  const h = harness([stats({ profile: 'mp3' })]);
  h.feed.ensure(9);
  const pcm = Buffer.from([1, 2, 3, 4]);
  h.decoders[0]?.spec.onPcm(pcm);
  assert.deepEqual(h.pushed, [{ zoneId: 9, pcm }]);
  h.feed.release(9);
});

test('ensure is idempotent — a second consumer does not open a second tap', () => {
  const h = harness([stats({ profile: 'mp3' })]);
  h.feed.ensure(4);
  h.feed.ensure(4);
  assert.equal(h.createStreamCalls.length, 1);
  h.feed.release(4);
});

test('a decoder that falls behind loses audio rather than the fan-out losing its pace', async () => {
  const h = harness([stats({ profile: 'flac' })]);
  h.feed.ensure(8);
  const stream = h.streams[0]!;
  const stdin = h.decoders[0]!.stdin;
  const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

  stream.write(Buffer.alloc(4096, 1));
  await settle();
  assert.equal(stdin.written.length, 1, 'a decoder that is keeping up gets everything');

  /*
   * The decoder is now a second behind. The fan-out reacts to a subscriber that does not keep up by
   * pausing the *producer* and eventually destroying the subscriber, so the tap must consume its
   * copy regardless and throw away what it cannot decode. Anything else lets a meter push back on
   * the audio the renderer is being sent.
   */
  stdin.writableLength = 512 * 1024;
  stream.write(Buffer.alloc(4096, 2));
  stream.write(Buffer.alloc(4096, 3));
  await settle();
  assert.equal(stdin.written.length, 1, 'dropped, not queued');
  assert.equal(stream.readableLength, 0, 'and read off the fan-out either way');

  // Once it has caught up, samples flow again without the tap being rebuilt.
  stdin.writableLength = 0;
  stream.write(Buffer.alloc(4096, 4));
  await settle();
  assert.equal(stdin.written.length, 2);
  assert.equal(h.createStreamCalls.length, 1, 'no re-attach was needed');
  h.feed.release(8);
});

test('a released tap that then ends does not resurrect itself', () => {
  const h = harness([stats({ profile: 'mp3' })]);
  h.feed.ensure(6);
  h.feed.release(6);
  // The decoder's exit lands after teardown — as it does in practice, since terminate() is async.
  h.decoders[0]?.spec.onEnded();
  assert.equal(h.createStreamCalls.length, 1);
});
