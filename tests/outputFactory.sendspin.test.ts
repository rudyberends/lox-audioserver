import assert from 'node:assert/strict';
import { test } from './testHarness';
import { buildZoneOutputs } from '../src/adapters/outputs/factory';
import type { ZoneConfig } from '../src/domain/config/types';
import type { ConfigPort } from '../src/ports/ConfigPort';
import { makeOutputPortsFake } from './fakes/outputPorts';
import { SendspinOutput } from '../src/adapters/outputs/sendspin/sendspinOutput';

function makeConfigPortStub(): ConfigPort {
  const fail = () => {
    throw new Error('config not configured');
  };
  return {
    load: async () => fail(),
    getConfig: fail,
    getSystemConfig: fail,
    getRawAudioConfig: fail,
    ensureInputs: fail,
    updateConfig: async () => fail(),
  };
}

function makeZone(overrides: Partial<ZoneConfig> = {}): ZoneConfig {
  return {
    id: 7,
    name: 'Living',
    sourceMac: '00:11:22:33:44:01',
    transports: [],
    volumes: {
      default: 30,
      alarm: 50,
      fire: 50,
      bell: 50,
      buzzer: 50,
      tts: 50,
      volstep: 2,
      fading: 0,
      maxVolume: 100,
    },
    inputs: {
      airplay: { enabled: false },
      spotify: { enabled: false },
      musicassistant: { enabled: false },
      lineIn: { enabled: false },
    },
    ...overrides,
  };
}

function takeSendspin(zone: ZoneConfig): SendspinOutput {
  const ports = makeOutputPortsFake(makeConfigPortStub());
  const outputs = buildZoneOutputs(zone, ports);
  const found = outputs.find((o): o is SendspinOutput => o.type === 'sendspin');
  assert.ok(found, 'expected a sendspin output to be created');
  return found;
}

test('Sendspin output accepts a clientIds array (multi-client zone)', () => {
  const sendspin = takeSendspin(
    makeZone({ transports: [{ id: 'sendspin', clientIds: ['stereo-room', 'subwoofer'] }] }),
  );
  assert.deepEqual(sendspin.getClientIds(), ['stereo-room', 'subwoofer']);
  assert.equal(sendspin.getClientId(), 'stereo-room');
});

test('Sendspin output accepts a comma-separated clientIds string', () => {
  const sendspin = takeSendspin(
    makeZone({ transports: [{ id: 'sendspin', clientIds: ' stereo-room , subwoofer ' }] }),
  );
  assert.deepEqual(sendspin.getClientIds(), ['stereo-room', 'subwoofer']);
});

test('Sendspin output accepts the legacy single clientId field', () => {
  const sendspin = takeSendspin(
    makeZone({ transports: [{ id: 'sendspin', clientId: 'solo-room' }] }),
  );
  assert.deepEqual(sendspin.getClientIds(), ['solo-room']);
  assert.equal(sendspin.getClientId(), 'solo-room');
});

test('Sendspin output de-duplicates repeated client IDs', () => {
  const sendspin = takeSendspin(
    makeZone({
      transports: [{ id: 'sendspin', clientIds: ['x', 'x', 'y'] }],
    }),
  );
  assert.deepEqual(sendspin.getClientIds(), ['x', 'y']);
});

test('Sendspin output is skipped when neither clientIds nor clientId is supplied', () => {
  const ports = makeOutputPortsFake(makeConfigPortStub());
  const outputs = buildZoneOutputs(
    makeZone({ transports: [{ id: 'sendspin' } as unknown as ZoneConfig['transports'][number]] }),
    ports,
  );
  assert.equal(
    outputs.some((o) => o.type === 'sendspin'),
    false,
  );
});

test('Sendspin output is skipped when clientIds is an empty / whitespace string', () => {
  const ports = makeOutputPortsFake(makeConfigPortStub());
  const outputs = buildZoneOutputs(
    makeZone({ transports: [{ id: 'sendspin', clientIds: '   ' }] }),
    ports,
  );
  assert.equal(
    outputs.some((o) => o.type === 'sendspin'),
    false,
  );
});
