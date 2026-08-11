import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from './testHarness';
import { AirPlayOutput } from '../src/adapters/outputs/airplay/airplayOutput';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { PlaybackSession } from '../src/application/playback/audioManager';
import { makeOutputPortsFake } from './fakes/outputPorts';

function makeConfigPortStub(): ConfigPort {
  return {
    load: async () => {
      throw new Error('config not configured');
    },
    getConfig: () => {
      throw new Error('config not configured');
    },
    getSystemConfig: () => {
      throw new Error('config not configured');
    },
    getRawAudioConfig: () => {
      throw new Error('config not configured');
    },
    ensureInputs: () => {
      throw new Error('config not configured');
    },
    updateConfig: async () => {
      throw new Error('config not configured');
    },
  };
}

/** Records every volume that actually reaches the RAOP layer. */
function makeSenderFake(): { volumes: number[] } & Record<string, unknown> {
  const volumes: number[] = [];
  return {
    volumes,
    isRunning: () => true,
    start: async () => true,
    setVolume: async (level: number) => {
      volumes.push(level);
    },
    pause: () => undefined,
    resume: () => undefined,
    stop: () => undefined,
    rebind: () => undefined,
    updateMetadata: () => undefined,
    getLatencyMs: () => 750,
  };
}

function makeStreamSessionFake(stream: PassThrough): Record<string, unknown> {
  return {
    getStream: () => stream,
    setPlaybackSource: () => undefined,
    setOnResubscribe: () => undefined,
    switchTrack: () => undefined,
    dispose: () => undefined,
  };
}

/** Minimal session; play() only looks at playbackSource and stream.id here. */
function makeSession(): PlaybackSession {
  return {
    zoneId: 1,
    stream: { id: 'stream-1' },
    playbackSource: { kind: 'url', url: 'http://localhost/stream.flac' },
  } as unknown as PlaybackSession;
}

function prepare(delayMs = 5): {
  output: AirPlayOutput;
  sender: { volumes: number[] } & Record<string, unknown>;
} {
  const ports = makeOutputPortsFake(makeConfigPortStub());
  const output = new AirPlayOutput(1, 'Zone', { host: '127.0.0.1' }, ports, 25);
  const sender = makeSenderFake();
  const internals = output as unknown as Record<string, unknown>;
  internals.sender = sender;
  internals.streamSession = makeStreamSessionFake(new PassThrough());
  internals.volumeAssertDelayMs = delayMs;
  return { output, sender };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('setVolume alone does not re-push an unchanged level (why #330 needs the assert)', async () => {
  const { output, sender } = prepare();

  await output.setVolume(25);

  assert.deepEqual(sender.volumes, []);
});

test('playback start asserts the volume even when the level never changed', async () => {
  const { output, sender } = prepare();
  // "Already active" play path: the sender stays connected across a start, so the
  // connect-time volume is the only one the device ever saw.
  (output as unknown as Record<string, unknown>).running = true;

  await output.play(makeSession());

  assert.deepEqual(sender.volumes, [25]);
});

test('the volume assert repeats once audio is flowing', async () => {
  const { output, sender } = prepare(5);
  (output as unknown as Record<string, unknown>).running = true;

  await output.play(makeSession());
  await sleep(30);

  assert.deepEqual(sender.volumes, [25, 25]);
});

test('stop cancels the pending mid-stream volume assert', async () => {
  const { output, sender } = prepare(5);
  (output as unknown as Record<string, unknown>).running = true;

  await output.play(makeSession());
  await output.stop(null);
  await sleep(30);

  assert.deepEqual(sender.volumes, [25]);
});
