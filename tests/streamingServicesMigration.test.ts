import assert from 'node:assert/strict';
import { test } from './testHarness';
import { normalizeContent } from '../src/application/config/configRepository';
import type { AudioServerConfig } from '../src/domain/config/types';

// The neutral streaming-account surface: non-Spotify accounts live in
// content.streamingServices, not the legacy content.spotify.bridges ("Spotify
// bridge" disguise). normalizeContent migrates the old location once and clears
// it, so the raw config never re-shows "Spotify bridge" for an Apple Music
// account. The migration is idempotent and preserves real Spotify accounts.

function baseConfig(spotify: Record<string, unknown>): AudioServerConfig {
  return {
    content: { radio: { tuneInUsername: '' }, spotify },
  } as unknown as AudioServerConfig;
}

test('migration: legacy spotify.bridges moves to content.streamingServices and clears', () => {
  const cfg = baseConfig({
    accounts: [{ id: 'real-spotify' }],
    bridges: [
      { id: 'bridge-applemusic-p0gngd', provider: 'applemusic', label: 'Apple Music' },
      { id: 'bridge-tidal-x', provider: 'tidal', label: 'Tidal' },
    ],
  });

  const changed = normalizeContent(cfg);

  assert.equal(changed, true, 'migration reports a change');
  assert.deepEqual(
    cfg.content.streamingServices?.map((s) => s.id),
    ['bridge-applemusic-p0gngd', 'bridge-tidal-x'],
    'accounts moved to streamingServices',
  );
  assert.deepEqual(cfg.content.spotify.bridges, [], 'legacy location cleared');
  assert.deepEqual(
    cfg.content.spotify.accounts,
    [{ id: 'real-spotify' }],
    'real Spotify accounts untouched',
  );
});

test('migration: idempotent — a second pass adds nothing and reports no change', () => {
  const cfg = baseConfig({
    accounts: [],
    bridges: [{ id: 'bridge-applemusic-p0gngd', provider: 'applemusic' }],
  });

  normalizeContent(cfg); // first pass migrates
  const before = JSON.stringify(cfg.content.streamingServices);
  const changed = normalizeContent(cfg); // second pass

  assert.equal(changed, false, 'no change on the second pass');
  assert.equal(JSON.stringify(cfg.content.streamingServices), before, 'no duplicate entries');
});

test('migration: existing streamingServices are merged, dedup by id', () => {
  const cfg = baseConfig({
    accounts: [],
    bridges: [
      { id: 'bridge-applemusic-p0gngd', provider: 'applemusic', label: 'from-legacy' },
      { id: 'bridge-tidal-x', provider: 'tidal' },
    ],
  });
  // A neutral account already present with the same id as a legacy bridge.
  cfg.content.streamingServices = [
    { id: 'bridge-applemusic-p0gngd', provider: 'applemusic', label: 'already-neutral' },
  ];

  normalizeContent(cfg);

  const ids = cfg.content.streamingServices?.map((s) => s.id);
  assert.deepEqual(ids, ['bridge-applemusic-p0gngd', 'bridge-tidal-x'], 'no duplicate id');
  // The pre-existing neutral entry wins (legacy duplicate is skipped).
  assert.equal(
    cfg.content.streamingServices?.find((s) => s.id === 'bridge-applemusic-p0gngd')?.label,
    'already-neutral',
  );
});
