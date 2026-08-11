import assert from 'node:assert/strict';
import { test } from '../testHarness';
import { AudioSession } from '../../src/engine/audioSession';
import type { AudioOutputSettings } from '../../src/engine/audioFormat';

const OUTPUT: AudioOutputSettings = {
  sampleRate: 44100,
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

/**
 * An alert: a short local file, which the outputs that pull over HTTP run unpaced, so the producer
 * reaches the end of it in tens of milliseconds — before the player has fetched the stream URL.
 */
function alertSession(onTerminated: () => void): AudioSession {
  return new AudioSession(
    1,
    { kind: 'file', path: '/app/public/alerts/bell.mp3', realTime: false },
    'flac',
    onTerminated,
    OUTPUT,
    null,
    false,
  );
}

test('audio that nobody has fetched yet outlives the producer', () => {
  let terminated = 0;
  const session = alertSession(() => {
    terminated += 1;
  });

  session.directPipeMode = true;
  session.emitOutputChunk(Buffer.alloc(4096, 7));
  session.handleProducerEnded();

  assert.equal(terminated, 0, 'the session must not be torn down while its audio is unclaimed');
  assert.notEqual(
    session.createSubscriber({ label: 'late-output' }),
    null,
    'the output arriving after the producer finished is the one this hold exists for',
  );

  session.stop(true);
  assert.equal(terminated, 1, 'stopping the held session still terminates it exactly once');
});

test('audio an output already took is torn down at once', () => {
  let terminated = 0;
  const session = alertSession(() => {
    terminated += 1;
  });

  session.directPipeMode = true;
  session.emitOutputChunk(Buffer.alloc(4096, 7));
  // Attaching primes the subscriber with the whole buffer, so there is nothing left to wait for —
  // delaying here would delay the next track at the end of every queued one.
  assert.notEqual(session.createSubscriber({ label: 'output' }), null);
  session.handleProducerEnded();

  assert.equal(terminated, 1, 'a collected session terminates on the spot');
});

test('a producer that failed is not held', () => {
  let terminated = 0;
  const session = alertSession(() => {
    terminated += 1;
  });

  session.directPipeMode = true;
  session.emitOutputChunk(Buffer.alloc(4096, 7));
  session.stop(true);

  assert.equal(terminated, 1, 'an explicit stop tears down immediately');
});
