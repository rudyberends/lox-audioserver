import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from './testHarness';
import { AirPlayOutput } from '../src/adapters/outputs/airplay/airplayOutput';
import type { ConfigPort } from '../src/ports/ConfigPort';
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

test('waitForPcmStream does not consume the first chunk', async () => {
  const outputPorts = makeOutputPortsFake(makeConfigPortStub());
  const output = new AirPlayOutput(1, 'Zone', { host: '127.0.0.1' }, outputPorts, 25);
  const stream = new PassThrough();
  const chunk = Buffer.from('pcmdata');

  const waitPromise = (output as any).waitForPcmStream(stream, 50);
  stream.write(chunk);

  const ready = await waitPromise;
  assert.equal(ready, true);

  const read = stream.read() as Buffer;
  assert.ok(read);
  assert.equal(read.toString('utf8'), chunk.toString('utf8'));
});

test('waitForPcmStream returns false on timeout', async () => {
  const outputPorts = makeOutputPortsFake(makeConfigPortStub());
  const output = new AirPlayOutput(2, 'Zone', { host: '127.0.0.1' }, outputPorts, 25);
  const stream = new PassThrough();

  const ready = await (output as any).waitForPcmStream(stream, 10);
  assert.equal(ready, false);
});
