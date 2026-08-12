import assert from 'node:assert/strict';
import { test } from './testHarness';
import { ZoneArtworkColorService } from '../src/application/artwork/zoneArtworkColorService';
import type { ArtworkPalette } from '../src/application/artwork/artworkPalette';
import type { ZoneState } from '../src/domain/zones/zoneState';

const palette = (tag: number): ArtworkPalette => ({
  primary: [tag, 0, 0],
  accent: [0, tag, 0],
  background_dark: [0, 0, tag],
  background_light: [tag, tag, tag],
  on_dark: [255, 255, 255],
  on_light: [0, 0, 0],
});

type Patch = { zoneId: number; patch: Partial<ZoneState> };

function harness(resolve: (coverUrl: string) => Promise<ArtworkPalette | null>) {
  const patches: Patch[] = [];
  const service = new ZoneArtworkColorService({
    getPalette: resolve,
    applyPatch: (zoneId, patch) => patches.push({ zoneId, patch }),
  });
  return { service, patches };
}

test('artwork colours follow coverurl for any zone, with no output involved', async () => {
  const { service, patches } = harness(async (url) =>
    url === 'http://cover/a.jpg' ? palette(1) : null,
  );

  // A patch that does not carry a cover is not an artwork event.
  service.onStatePatch(1, { title: 'Song' });
  assert.deepEqual(patches, []);

  service.onStatePatch(1, { coverurl: 'http://cover/a.jpg' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(patches, [{ zoneId: 1, patch: { artworkColors: palette(1) } }]);

  // Re-reporting the same cover (a heartbeat, a queue refresh) must not refetch or re-patch.
  service.onStatePatch(1, { coverurl: 'http://cover/a.jpg' });
  await new Promise((r) => setImmediate(r));
  assert.equal(patches.length, 1);

  // Losing the artwork clears the palette synchronously — there is nothing to fetch.
  service.onStatePatch(1, { coverurl: '' });
  assert.deepEqual(patches[1], { zoneId: 1, patch: { artworkColors: null } });
});

test('a slow cover fetch cannot repaint a zone that already moved on', async () => {
  const pending = new Map<string, (palette: ArtworkPalette | null) => void>();
  const { service, patches } = harness(
    (url) => new Promise<ArtworkPalette | null>((resolve) => pending.set(url, resolve)),
  );

  service.onStatePatch(7, { coverurl: 'http://cover/slow.jpg' });
  service.onStatePatch(7, { coverurl: 'http://cover/fast.jpg' });

  // The second track resolves first, then the first track's request finally lands. Without the
  // per-zone guard the stale palette would overwrite the current one and the display would show
  // the previous track's colours.
  pending.get('http://cover/fast.jpg')?.(palette(2));
  await new Promise((r) => setImmediate(r));
  pending.get('http://cover/slow.jpg')?.(palette(3));
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(patches, [{ zoneId: 7, patch: { artworkColors: palette(2) } }]);
});

test('an unreadable cover leaves the zone without a palette rather than a stale one', async () => {
  const { service, patches } = harness(async () => null);
  service.onStatePatch(4, { coverurl: 'http://cover/broken.jpg' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(patches, [{ zoneId: 4, patch: { artworkColors: null } }]);
});
