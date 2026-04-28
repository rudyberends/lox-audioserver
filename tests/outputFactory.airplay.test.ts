import assert from 'node:assert/strict';
import { test } from './testHarness';
import { buildZoneOutputs } from '../src/adapters/outputs/factory';
import type { ZoneConfig } from '../src/domain/config/types';
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

function makeZone(overrides: Partial<ZoneConfig> = {}): ZoneConfig {
  return {
    id: 1,
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

test('explicit AirPlay output is independent from AirPlay input enablement', () => {
  const ports = makeOutputPortsFake(makeConfigPortStub());
  const zone = makeZone({
    transports: [{ id: 'airplay', host: 'homepod.local' }],
    inputs: {
      airplay: { enabled: false },
      spotify: { enabled: false },
      musicassistant: { enabled: false },
      lineIn: { enabled: false },
    },
  });

  const outputs = buildZoneOutputs(zone, ports);

  assert.ok(outputs.some((output) => output.type === 'airplay'));
});

test('AirPlay input enablement does not create an AirPlay output', () => {
  const ports = makeOutputPortsFake(makeConfigPortStub());
  const zone = makeZone({
    transports: [],
    inputs: {
      airplay: { enabled: true },
      spotify: { enabled: false },
      musicassistant: { enabled: false },
      lineIn: { enabled: false },
    },
  });

  const outputs = buildZoneOutputs(zone, ports);

  assert.equal(outputs.some((output) => output.type === 'airplay'), false);
});
