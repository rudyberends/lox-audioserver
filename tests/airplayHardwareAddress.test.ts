import assert from 'node:assert/strict';
import { test } from './testHarness';
import { deriveHardwareAddress } from '../src/adapters/inputs/airplay/airplayInstance';

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;

test('zones sharing one extension serial get distinct addresses', () => {
  const a = deriveHardwareAddress('88AEDD681068', 5);
  const b = deriveHardwareAddress('88AEDD681068', 6);
  assert.match(a, MAC_RE);
  assert.match(b, MAC_RE);
  assert.notEqual(a, b);
});

test('sibling serials with colliding zone-id sums get distinct addresses (#356)', () => {
  // Old derivation: last byte = serial last byte + zoneId, so ..68+5 and ..67+6
  // both landed on ..6d and two rooms advertised the same RAOP identifier.
  const wohnzimmer = deriveHardwareAddress('88AEDD681068', 5);
  const elternbad = deriveHardwareAddress('88AEDD681067', 6);
  assert.notEqual(wohnzimmer, elternbad);
});

test('same zone id on two servers with near-identical serials stays distinct', () => {
  const serverA = deriveHardwareAddress('88AEDD681067', 1);
  const serverB = deriveHardwareAddress('88AEDD681079', 1);
  assert.notEqual(serverA, serverB);
});

test('address is stable and normalizes serial formatting', () => {
  const plain = deriveHardwareAddress('88AEDD681068', 5);
  assert.equal(deriveHardwareAddress('88AEDD681068', 5), plain);
  assert.equal(deriveHardwareAddress('88:ae:dd:68:10:68', 5), plain);
});

test('address is unicast and locally administered', () => {
  for (const [serial, zoneId] of [['88AEDD681068', 1], ['', 7]] as const) {
    const first = Number.parseInt(deriveHardwareAddress(serial, zoneId).slice(0, 2), 16);
    assert.equal(first & 0x02, 0x02, 'locally administered bit set');
    assert.equal(first & 0x01, 0x00, 'multicast bit clear');
  }
});
