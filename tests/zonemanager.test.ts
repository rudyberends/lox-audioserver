import assert from 'node:assert/strict';

import { mergeZoneConfigEntries } from '../src/backend/zone/zoneConfigUtils';
import type { ZoneConfigEntry } from '../src/config/configStore';

export function runMergeZoneConfigEntriesTests() {
  const existing: ZoneConfigEntry[] = [
    { id: 1, backend: 'DummyBackend', ip: '127.0.0.1' },
  ];
  const newEntries: ZoneConfigEntry[] = [
    { id: 2, backend: 'BackendSonos', ip: '10.0.0.2' },
  ];

  const firstMerge = mergeZoneConfigEntries(existing, newEntries);
  assert.deepEqual(firstMerge.added, newEntries);
  assert.equal(firstMerge.merged.length, 2);
  assert.deepEqual(firstMerge.merged[1], newEntries[0]);

  const duplicateMerge = mergeZoneConfigEntries(existing, [{ id: 1, backend: 'BackendSonos', ip: '10.0.0.2' }]);
  assert.equal(duplicateMerge.added.length, 0);
  assert.equal(duplicateMerge.merged.length, existing.length);
  assert.deepEqual(duplicateMerge.merged[0], existing[0]);
}
