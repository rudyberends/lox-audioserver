import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from './testHarness';
import type { EnginePort, EngineSessionTerminationHandler, EngineSessionStats } from '../src/ports/EnginePort';
import { PlaybackService } from '../src/application/playback/PlaybackService';
import { AudioManager } from '../src/application/playback/audioManager';

function makeEngineFake() {
  let terminationHandler: EngineSessionTerminationHandler | null = null;
  const engine: EnginePort & { emitTermination: (zoneId: number, stats: EngineSessionStats | null, reason?: string) => void } = {
    start: () => {
      /* noop */
    },
    startWithHandoff: () => {
      /* noop */
    },
    stop: () => {
      /* noop */
    },
    createStream: () => new PassThrough(),
    createLocalSession: () => ({
      start: () => {
        /* noop */
      },
      stop: () => {
        /* noop */
      },
      createSubscriber: () => null,
    }),
    waitForFirstChunk: async () => true,
    hasSession: () => true,
    getSessionStats: () => [],
    setSessionTerminationHandler: (handler) => {
      terminationHandler = handler;
    },
    emitTermination: (zoneId, stats, reason) => {
      terminationHandler?.(zoneId, stats, reason);
    },
  };
  return engine;
}

test('audio manager emits end_of_track when engine ends cleanly without a known duration', () => {
  const engine = makeEngineFake();
  let lastError: string | null = null;
  const audioManager = new AudioManager(new PlaybackService(engine), {
    notifyOutputError: (_zoneId, reason) => {
      lastError = reason ?? null;
    },
    notifyOutputState: () => {
      /* noop */
    },
  });

  const zoneId = 1;
  const session = audioManager.startExternalPlayback(
    zoneId,
    'applemusic',
    { kind: 'url', url: 'http://example.invalid/stream.m3u8' } as any,
    { title: 't', artist: 'a', album: 'b', duration: 0 },
    true,
  );
  assert.ok(session);
  // Make the session look like it has been playing for a bit (clock-based elapsed).
  (audioManager.getSession(zoneId) as any).startedAt = Date.now() - 10_000;

  engine.emitTermination(zoneId, {
    profile: 'pcm',
    bps: null,
    bufferedBytes: 0,
    totalBytes: 1024,
    lastUpdated: Date.now(),
    subscribers: 0,
    restarts: 0,
    lastError: null,
    lastErrorAt: null,
    lastStderr: null,
    lastStderrAt: null,
    lastExitCode: 0,
    lastExitSignal: null,
    lastExitAt: Date.now(),
    subscriberDrops: 0,
    lastSubscriberDropAt: null,
  });

  assert.equal(lastError, 'end_of_track');
});

test('audio manager does not emit end_of_track when engine exits with an error', () => {
  const engine = makeEngineFake();
  const errors: string[] = [];
  const audioManager = new AudioManager(new PlaybackService(engine), {
    notifyOutputError: (_zoneId, reason) => {
      if (reason) errors.push(reason);
    },
    notifyOutputState: () => {
      /* noop */
    },
  });

  const zoneId = 1;
  const session = audioManager.startExternalPlayback(
    zoneId,
    'applemusic',
    { kind: 'url', url: 'http://example.invalid/stream.m3u8' } as any,
    { title: 't', artist: 'a', album: 'b', duration: 0 },
    true,
  );
  assert.ok(session);
  (audioManager.getSession(zoneId) as any).startedAt = Date.now() - 10_000;

  engine.emitTermination(zoneId, {
    profile: 'pcm',
    bps: null,
    bufferedBytes: 0,
    totalBytes: 1024,
    lastUpdated: Date.now(),
    subscribers: 0,
    restarts: 0,
    lastError: null,
    lastErrorAt: null,
    lastStderr: 'network error',
    lastStderrAt: Date.now(),
    lastExitCode: 1,
    lastExitSignal: null,
    lastExitAt: Date.now(),
    subscriberDrops: 0,
    lastSubscriberDropAt: null,
  });

  assert.ok(!errors.includes('end_of_track'));
});

