import assert from 'node:assert/strict';
import { test } from './testHarness';
import { handlePlaybackError } from '../src/application/zones/playback/playbackErrors';
import type { ZoneContext } from '../src/application/zones/internal/zoneTypes';
import type { ZoneState } from '../src/domain/zones/zoneState';

function buildZone(inputMode: ZoneContext['inputMode']): {
  ctx: ZoneContext;
  patches: Array<Partial<ZoneState>>;
  stops: number;
} {
  const patches: Array<Partial<ZoneState>> = [];
  const stopped = { count: 0 };
  const ctx = {
    id: 1,
    sourceMac: '00:00:00:00:00:01',
    inputMode,
    player: {
      getState: () => ({ mode: 'playing' }),
      stop: () => {
        stopped.count += 1;
      },
    },
  } as unknown as ZoneContext;
  return {
    ctx,
    patches,
    get stops() {
      return stopped.count;
    },
  };
}

function run(
  zone: ReturnType<typeof buildZone>,
  origin?: { input: 'spotify' },
): void {
  handlePlaybackError({
    coordinator: {
      getZone: () => zone.ctx,
      applyPatch: (_zoneId, patch) => {
        zone.patches.push(patch);
      },
      log: { warn: () => {}, debug: () => {} } as any,
    },
    zoneId: 1,
    reason: 'spotify audio_key_error',
    source: 'output',
    origin,
  });
}

test('a spotify error is ignored while the zone plays an announcement (#293)', () => {
  const zone = buildZone('alert');

  run(zone, { input: 'spotify' });

  // librespot reports its failure after the alert took the room over; stopping the zone
  // here is what cut announcements off mid-sentence.
  assert.deepEqual(zone.patches, []);
  assert.equal(zone.stops, 0);
});

test('a spotify error still stops the zone while spotify is its input', () => {
  const zone = buildZone('spotify');

  run(zone, { input: 'spotify' });

  assert.equal(zone.patches.length, 1);
  assert.equal(zone.patches[0]?.mode, 'stop');
  assert.equal(zone.patches[0]?.title, 'Spotify unavailable');
  assert.equal(zone.stops, 1);
});

test('an unattributed error applies whatever the zone is playing', () => {
  const zone = buildZone('alert');

  run(zone);

  // Renderer errors (a dead output, a failed decode) are about the zone itself.
  assert.equal(zone.patches.length, 1);
  assert.equal(zone.stops, 1);
});
