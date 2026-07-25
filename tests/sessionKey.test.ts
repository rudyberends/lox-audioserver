import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  allocateEphemeralSessionKey,
  zoneSessionKey,
} from '../src/ports/types/SessionKey';

test('zoneSessionKey preserves the numeric zoneId value', () => {
  for (const zoneId of [1, 8, 27, 8999]) {
    assert.equal(zoneSessionKey(zoneId) as number, zoneId);
  }
});

test('allocateEphemeralSessionKey returns negative keys', () => {
  for (let i = 0; i < 100; i++) {
    const key = allocateEphemeralSessionKey() as number;
    assert.ok(key < 0, `expected negative key, got ${key}`);
  }
});

test('ephemeral keys never collide with a positive zoneId', () => {
  // Zone ids are positive (config 1..8999, browser 9000..9999). Ephemeral keys
  // live in the negative range, so a termination callback fired with one can
  // never resolve against a zone sessions map keyed by zoneId.
  const zoneKeys = new Set<number>();
  for (let z = 1; z <= 9999; z++) {
    zoneKeys.add(zoneSessionKey(z) as number);
  }
  for (let i = 0; i < 1000; i++) {
    const key = allocateEphemeralSessionKey() as number;
    assert.ok(!zoneKeys.has(key), `ephemeral key ${key} collided with a zoneId`);
  }
});

test('ephemeral keys are unique across a large window', () => {
  const seen = new Set<number>();
  for (let i = 0; i < 10_000; i++) {
    const key = allocateEphemeralSessionKey() as number;
    assert.ok(!seen.has(key), `duplicate ephemeral key ${key}`);
    seen.add(key);
  }
});
