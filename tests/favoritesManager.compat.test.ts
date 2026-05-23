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

test('favorites manager exposes ownerId/owner_id for spotify_playlist favorites', async () => {
  await withTempCwd(async () => {
    await fs.mkdir(path.join(process.cwd(), 'data', 'favorites'), { recursive: true });
    await fs.writeFile(
      path.join(process.cwd(), 'data', 'favorites', '11.json'),
      JSON.stringify({
        id: 11,
        type: 4,
        start: 0,
        totalitems: 2,
        items: [
          {
            id: 3,
            slot: 3,
            plus: true,
            name: 'Ben Böhmer Radio',
            title: 'Ben Böhmer Radio',
            audiopath: 'spotify:playlist:37i9dQZF1E4pZXZH78vpiC',
            type: 'spotify_playlist',
            coverurl: '',
            artist: '',
            album: '',
            service: 'spotify',
            serviceType: 3,
            owner: 'Timo',
          },
          {
            id: 4,
            slot: 4,
            plus: true,
            name: 'Liked Songs',
            title: 'Liked Songs',
            audiopath: 'spotify:user:collection',
            type: 'spotify_collection',
            coverurl: '',
            artist: '',
            album: '',
            service: 'spotify',
            serviceType: 3,
            owner: 'Timo',
          },
        ],
      }),
    );

    const favoritesManager = createFavoritesManager({
      notifier: { notifyRoomFavoritesChanged: () => {} } as any,
      contentPort: { resolveMetadata: async () => null } as any,
    });
    favoritesManager.initOnce({ zoneManager: { getState: () => undefined } as any });

    const result = await favoritesManager.get(11);
    const playlist = result.items[0] as Record<string, unknown>;
    const collection = result.items[1] as Record<string, unknown>;

    assert.equal(playlist.type, 'spotify_playlist');
    assert.equal(playlist.ownerId, 'Timo');
    assert.equal(playlist.owner_id, 'Timo');

    assert.equal(collection.type, 'spotify_collection');
    assert.equal(collection.ownerId, 'Timo');
    assert.equal(collection.owner_id, 'Timo');
  });
});

test('favorites manager omits ownerId for non-spotify-playlist favorites', async () => {
  await withTempCwd(async () => {
    await fs.mkdir(path.join(process.cwd(), 'data', 'favorites'), { recursive: true });
    await fs.writeFile(
      path.join(process.cwd(), 'data', 'favorites', '12.json'),
      JSON.stringify({
        id: 12,
        type: 4,
        start: 0,
        totalitems: 1,
        items: [
          {
            id: 1,
            slot: 1,
            plus: true,
            name: 'WDR 2',
            title: 'WDR 2',
            audiopath: 'https://example.com/wdr2.mp3',
            type: 'custom_stream',
            coverurl: '',
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

    const result = await favoritesManager.get(12);
    const radio = result.items[0] as Record<string, unknown>;
    assert.equal('ownerId' in radio, false);
    assert.equal('owner_id' in radio, false);
  });
});

test('favorites manager stores stream favorites as custom_stream', async () => {
  await withTempCwd(async () => {
    const favoritesManager = createFavoritesManager({
      notifier: { notifyRoomFavoritesChanged: () => {} } as any,
      contentPort: { resolveMetadata: async () => null } as any,
    });
    favoritesManager.initOnce({ zoneManager: { getState: () => undefined } as any });

    const created = await favoritesManager.add(11, 'Web Radio', 'https://example.com/radio.m3u8');
    assert.equal(created.type, 'custom_stream');

    const result = await favoritesManager.get(11);
    assert.equal(result.items[0]?.type, 'custom_stream');
  });
});
