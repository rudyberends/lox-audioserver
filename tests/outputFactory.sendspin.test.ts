import assert from 'node:assert/strict';
import { test } from './testHarness';
import { buildZoneOutputs, parseSendspinSatellites } from '../src/adapters/outputs/factory';
import type { ZoneConfig } from '../src/domain/config/types';
import type { ConfigPort } from '../src/ports/ConfigPort';
import { makeOutputPortsFake } from './fakes/outputPorts';

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
  } as unknown as ConfigPort;
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

/** Helper: ids only, since the parser returns `{ clientId, latencyMs?, endpointUrl? }`. */
const ids = (raw: unknown, primary = 'primary'): string[] =>
  parseSendspinSatellites(raw, primary).map((s) => s.clientId);

// --- parseSendspinSatellites ----------------------------------------------

test('satellites: array of client ids', () => {
  assert.deepEqual(ids(['sub', 'ledfx']), ['sub', 'ledfx']);
});

test('satellites: comma-separated string', () => {
  assert.deepEqual(ids(' sub , ledfx ,, '), ['sub', 'ledfx']);
});

test('satellites: rich objects keep per-satellite latency', () => {
  assert.deepEqual(parseSendspinSatellites([{ clientId: 'sub', latencyMs: 12 }, { clientId: 'ledfx' }], 'primary'), [
    { clientId: 'sub', latencyMs: 12 },
    { clientId: 'ledfx' },
  ]);
});

test('satellites: numeric-string latency is coerced', () => {
  assert.deepEqual(parseSendspinSatellites([{ clientId: 'sub', latencyMs: '12' }], 'primary'), [
    { clientId: 'sub', latencyMs: 12 },
  ]);
});

test('satellites: de-duplicates and excludes the primary client', () => {
  assert.deepEqual(ids(['sub', 'sub', 'primary', 'ledfx'], 'primary'), ['sub', 'ledfx']);
});

test('satellites: empty / whitespace / undefined yields none', () => {
  assert.deepEqual(ids('   '), []);
  assert.deepEqual(ids(undefined), []);
  assert.deepEqual(ids([]), []);
  assert.deepEqual(ids([{ foo: 'bar' }]), []);
});

// --- buildZoneOutputs (sendspin) ------------------------------------------

function satellitesOf(output: unknown): string[] {
  return (output as { getSatelliteClientIds(): string[] }).getSatelliteClientIds();
}

test('sendspin output wires satellites through to the pipeline', () => {
  const ports = makeOutputPortsFake(makeConfigPortStub());
  const zone = makeZone({
    transports: [{ id: 'sendspin', clientId: 'room', satellites: ['sub', 'ledfx'] } as never],
  });
  const outputs = buildZoneOutputs(zone, ports);
  const sendspin = outputs.find((o) => o.type === 'sendspin');
  assert.ok(sendspin, 'expected a sendspin output');
  assert.deepEqual(satellitesOf(sendspin), ['sub', 'ledfx']);
});

test('sendspin output: legacy single clientId has no satellites', () => {
  const ports = makeOutputPortsFake(makeConfigPortStub());
  const zone = makeZone({ transports: [{ id: 'sendspin', clientId: 'room' } as never] });
  const sendspin = buildZoneOutputs(zone, ports).find((o) => o.type === 'sendspin');
  assert.ok(sendspin, 'expected a sendspin output');
  assert.deepEqual(satellitesOf(sendspin), []);
});

test('sendspin output is skipped without a clientId', () => {
  const ports = makeOutputPortsFake(makeConfigPortStub());
  const zone = makeZone({ transports: [{ id: 'sendspin', satellites: ['sub'] } as never] });
  assert.equal(
    buildZoneOutputs(zone, ports).some((o) => o.type === 'sendspin'),
    false,
  );
});

test('cast (sendspin) primary fans satellites through its base pipeline', () => {
  const ports = makeOutputPortsFake(makeConfigPortStub());
  const zone = makeZone({
    transports: [
      { id: 'googleCast', host: '10.0.0.5', useSendspin: true, satellites: 'sub, ledfx' } as never,
    ],
  });
  const cast = buildZoneOutputs(zone, ports).find((o) => o.type === 'sendspin-cast');
  assert.ok(cast, 'expected a sendspin-cast output');
  assert.deepEqual(satellitesOf(cast), ['sub', 'ledfx']);
});
