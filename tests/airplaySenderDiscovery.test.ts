import assert from 'node:assert/strict';
import { test } from './testHarness';
import { resolveConfiguredAirplayConfig, resolveDiscoveredAirplayConfig } from '../src/adapters/outputs/airplay/airplaySender';
import { airplayTxtSuggestsAirPlay2, type AirplayDeviceDescriptor } from '../src/adapters/outputs/airplay/airplayDiscovery';

function device(protocol: 'airplay' | 'raop', port: number, txt: Record<string, unknown> = {}): AirplayDeviceDescriptor {
  return {
    id: `${protocol}-${port}`,
    name: 'Receiver',
    host: 'receiver.local',
    address: '192.0.2.10',
    port,
    protocol,
    txt,
  };
}

test('airplay discovery prefers RAOP when both services are advertised', () => {
  const resolved = resolveDiscoveredAirplayConfig([
    device('airplay', 7000, { pi: 'pairing-id', pk: 'public-key' }),
    device('raop', 5000, { cn: '0,1', et: '0,1' }),
  ]);

  assert.equal(resolved.port, 5000);
  assert.equal(resolved.forceAp2, false);
});

test('airplay discovery does not force AP2 from _airplay alone', () => {
  const resolved = resolveDiscoveredAirplayConfig([device('airplay', 7000, { model: 'Denon AVR-X1100W', srcvers: '220.68' })]);

  assert.equal(resolved.port, undefined);
  assert.equal(resolved.forceAp2, false);
});

test('airplay discovery enables AP2 when TXT advertises pairing identity', () => {
  const resolved = resolveDiscoveredAirplayConfig([device('airplay', 7000, { pi: 'pairing-id', pk: 'public-key' })]);

  assert.equal(resolved.port, 7000);
  assert.equal(resolved.forceAp2, true);
});

test('airplay discovery recognizes AP2 TXT keys used by the web UI label', () => {
  assert.equal(airplayTxtSuggestsAirPlay2({ pi: 'pairing-id', pk: 'public-key' }), true);
  assert.equal(airplayTxtSuggestsAirPlay2({ model: 'Denon AVR-X1100W', srcvers: '220.68' }), false);
});

test('airplay configured AP2 falls back when discovery only finds RAOP', () => {
  const resolved = resolveConfiguredAirplayConfig({ port: 7000, forceAp2: true }, [
    device('airplay', 7000, { model: 'Denon AVR-X1100W', srcvers: '220.68' }),
    device('raop', 5000, { cn: '0,1', et: '0,1' }),
  ]);

  assert.equal(resolved?.port, 5000);
  assert.equal(resolved?.forceAp2, false);
});

test('airplay configured AP2 is kept when discovery advertises AP2 identity', () => {
  const resolved = resolveConfiguredAirplayConfig({ port: 7000, forceAp2: true }, [
    device('airplay', 7000, { pi: 'pairing-id', pk: 'public-key' }),
    device('raop', 5000, { cn: '0,1', et: '0,1' }),
  ]);

  assert.equal(resolved?.port, 7000);
  assert.equal(resolved?.forceAp2, true);
});
