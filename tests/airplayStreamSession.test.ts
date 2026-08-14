import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from './testHarness';
import { AirplayStreamSession } from '../src/adapters/outputs/airplay/airplayStreamSession';
import { audioOutputSettings } from '../src/ports/types/audioFormat';
import type { EnginePort } from '../src/ports/EnginePort';

test('airplay stream session uses zone engine stream before local fallback', () => {
  let createLocalSessionCalls = 0;
  let createStreamCalls = 0;
  const sharedSource = new PassThrough();
  const engine: EnginePort = {
    start: () => {
      /* noop */
    },
    startWithHandoff: () => {
      /* noop */
    },
    stop: () => {
      /* noop */
    },
    createStream: () => {
      createStreamCalls += 1;
      return sharedSource;
    },
    createLocalSession: () => {
      createLocalSessionCalls += 1;
      return {
        start: () => {
          /* noop */
        },
        stop: () => {
          /* noop */
        },
        createSubscriber: () => new PassThrough(),
      };
    },
    waitForFirstChunk: async () => false,
    hasSession: () => true,
    getSessionStats: () => [],
    setSessionTerminationHandler: () => {
      /* noop */
    },
    restartZoneForEqualizer: () => false,
    inlineCrossfade: async () => false,
  };

  const session = new AirplayStreamSession(6, engine);
  session.setPlaybackSource(
    {
      kind: 'url',
      url: 'http://stream.example/radio.mp3',
      realTime: true,
    },
    audioOutputSettings,
  );
  const stream = session.getStream();

  assert.ok(stream);
  assert.ok(createStreamCalls >= 1);
  assert.equal(createLocalSessionCalls, 0);
  session.dispose();
});
