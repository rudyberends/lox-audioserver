import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from './testHarness';
import { createFavoritesManager } from '../src/application/zones/favorites/favoritesManager';

async function withTempCwd(fn: () => Promise<void>): Promise<void> {
  const originalCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lox-favorites-test-'));
  process.chdir(tempDir);
  try {
    await fn();
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test('favorites manager normalizes legacy local favorite types for app compatibility', async () => {
  await withTempCwd(async () => {
    await fs.mkdir(path.join(process.cwd(), 'data', 'favorites'), { recursive: true });
    await fs.writeFile(
      path.join(process.cwd(), 'data', 'favorites', '27.json'),
      JSON.stringify({
        id: 27,
        type: 4,
        start: 0,
        totalitems: 1,
        items: [
          {
            id: 4,
            slot: 4,
            plus: true,
            name: 'Azizam',
            title: 'Azizam',
            audiopath: 'library:local:track:b64_example',
            type: 'custom_track',
            coverurl: '',
            artist: '',
            album: '',
            service: 'custom',
            serviceType: 3,
            owner: '',
          },
        ],
      }),
    );

    const favoritesManager = createFavoritesManager({
      notifier: { notifyRoomFavoritesChanged: () => {} } as any,
      contentPort: { resolveMetadata: async () => null } as any,
    });
    favoritesManager.initOnce({ zoneManager: { getState: () => undefined } as any });

    const result = await favoritesManager.get(27);
    assert.equal(result.items[0]?.type, 'library_track');
    assert.equal(result.items[0]?.service, 'library');
    assert.equal(result.items[0]?.serviceType, 2);
  });
});

test('favorites manager stores stream favorites as tunein', async () => {
  await withTempCwd(async () => {
    const favoritesManager = createFavoritesManager({
      notifier: { notifyRoomFavoritesChanged: () => {} } as any,
      contentPort: { resolveMetadata: async () => null } as any,
    });
    favoritesManager.initOnce({ zoneManager: { getState: () => undefined } as any });

    const created = await favoritesManager.add(11, 'Web Radio', 'https://example.com/radio.m3u8');
    assert.equal(created.type, 'tunein');

    const result = await favoritesManager.get(11);
    assert.equal(result.items[0]?.type, 'tunein');
  });
});
