import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from './testHarness';
import { LocalLibraryStore } from '../src/adapters/content/providers/localLibraryStore';

test('local library store: search finds tracks/albums/artists', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lox-audioserver-libstore-'));
  const dbPath = path.join(tempDir, 'library.db');

  const store = new LocalLibraryStore({ dbPath });
  await store.init();

  store.insertTrack({
    storageId: 'local',
    relPath: 'music/Red Hot Chili Peppers/Californication/01 - Around the World.mp3',
    title: 'Around the World',
    album: 'Californication',
    artist: 'Red Hot Chili Peppers',
    audiopath: 'library:local:track:1',
    cover: undefined,
    mtime: undefined,
    size: undefined,
    duration: undefined,
  });
  store.insertTrack({
    storageId: 'local',
    relPath: 'music/Daft Punk/Discovery/01 - One More Time.mp3',
    title: 'One More Time',
    album: 'Discovery',
    artist: 'Daft Punk',
    audiopath: 'library:local:track:2',
    cover: undefined,
    mtime: undefined,
    size: undefined,
    duration: undefined,
  });

  const tracks = store.searchTracks('calif', 10);
  assert.ok(tracks.some((t) => t.album === 'Californication'));

  const albums = store.searchAlbums('calif', 10);
  assert.ok(albums.some((a) => a.album === 'Californication'));

  const artists = store.searchArtists('daft', 10);
  assert.ok(artists.some((a) => a.name === 'Daft Punk'));
});
