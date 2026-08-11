import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SonosOutput } from '../src/adapters/outputs/sonos/sonosOutput';
import { SonosStateController } from '../src/application/zones/state/SonosStateController';
import { dispatchOutputs } from '../src/application/zones/services/outputOrchestrator';

// Regression coverage for issue #327 ("play after pause does not work"): a Sonos websocket that
// had gone stale made pause reject, the rejection was escalated to a fatal playback error, and
// the follow-up play was then swallowed by the state controller.

class StaleSocketError extends Error {
  constructor() {
    super('Not connected');
    // node-sonos derives `name` from the error class; the adapter matches on that.
    this.name = 'NotConnected';
  }
}

function createOutput(groupCommand: () => Promise<void>) {
  const soapActions: string[] = [];
  const disconnected: boolean[] = [];
  const output = new SonosOutput(
    5,
    'Büro',
    { controlUrl: 'http://192.168.20.34:1400/MediaRenderer/AVTransport/Control' },
    {
      sonosGroup: { register: () => undefined, unregister: () => undefined },
    } as any,
  ) as any;
  const client = {
    player: { group: { pause: groupCommand, play: groupCommand, stop: groupCommand } },
    disconnect: async () => {
      disconnected.push(true);
    },
  };
  output.s2Client = client;
  output.invokeAction = async (action: string) => {
    soapActions.push(action);
    return true;
  };
  return { output, soapActions, disconnected, client };
}

const session = { zoneId: 5, playbackSource: 'library://track.mp3' } as any;

test('sonos pause falls back to SOAP and drops the client when the websocket is stale', async () => {
  const { output, soapActions, disconnected } = createOutput(async () => {
    throw new StaleSocketError();
  });

  await output.pause(session);

  assert.deepEqual(soapActions, ['Pause']);
  assert.equal(output.s2Client, null, 'stale client must be dropped so the next command reconnects');
  assert.deepEqual(disconnected, [true]);
});

test('sonos stop and resume survive a stale websocket too', async () => {
  const stop = createOutput(async () => {
    throw new StaleSocketError();
  });
  await stop.output.stop(session);
  assert.deepEqual(stop.soapActions, ['Stop']);

  const resume = createOutput(async () => {
    throw new StaleSocketError();
  });
  await resume.output.resume(null);
  assert.deepEqual(resume.soapActions, ['Play']);
});

test('sonos pause keeps a healthy websocket client and skips SOAP', async () => {
  const calls: string[] = [];
  const { output, soapActions } = createOutput(async () => {
    calls.push('s2');
  });

  await output.pause(session);

  assert.deepEqual(calls, ['s2']);
  assert.deepEqual(soapActions, []);
  assert.notEqual(output.s2Client, null);
});

test('sonos keeps the client on a refused command; only connection loss drops it', async () => {
  const { output, soapActions } = createOutput(async () => {
    const err = new Error('Command failed: ERROR_PLAYBACK_FAILED');
    err.name = 'FailedCommand';
    throw err;
  });

  await output.pause(session);

  assert.deepEqual(soapActions, ['Pause'], 'a refused S2 command still falls back to SOAP');
  assert.notEqual(output.s2Client, null, 'a refused command says nothing about the socket');
});

function dispatchWithFailingOutput(action: 'play' | 'pause' | 'stop') {
  const errors: string[] = [];
  const ctx = {
    id: 5,
    config: {},
    activeInput: 'queue',
    activeOutput: 'sonos',
    activeOutputTypes: new Set(['sonos']),
  } as any;
  const outputs = [
    {
      type: 'sonos',
      play: async () => {
        throw new Error('Not connected');
      },
      pause: async () => {
        throw new Error('Not connected');
      },
      stop: async () => {
        throw new Error('Not connected');
      },
    },
  ] as any;
  dispatchOutputs(
    ctx,
    outputs,
    action,
    { zoneId: 5, playbackSource: 'library://track.mp3' } as any,
    { debug: () => undefined, warn: () => undefined, info: () => undefined } as any,
    (_zoneId, reason) => {
      errors.push(String(reason));
    },
  );
  return errors;
}

test('a failed pause or stop is not escalated to a fatal playback error', async () => {
  const pauseErrors = dispatchWithFailingOutput('pause');
  const stopErrors = dispatchWithFailingOutput('stop');
  const playErrors = dispatchWithFailingOutput('play');
  // The rejections are reported asynchronously.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(pauseErrors, [], 'a session that is still valid must not be torn down');
  assert.deepEqual(stopErrors, []);
  assert.deepEqual(playErrors, ['Not connected'], 'silence after play must still surface');
});

test('sonos state controller declines transport commands when it has no live group', () => {
  const controller = new SonosStateController({
    zone: { id: 5, name: 'Büro', output: { host: '192.168.20.34' } as any } as any,
    onStatePatch: () => undefined,
  } as any) as any;

  assert.equal(controller.handleCommand('play'), false, 'declining hands the command back to local playback');

  let dispatched = 0;
  controller.client = { player: { group: { play: async () => { dispatched += 1; } } } };
  assert.equal(controller.handleCommand('play'), true);
  assert.equal(controller.handleCommand('nonsense'), false);
});
