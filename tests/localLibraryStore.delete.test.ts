import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from './testHarness';
import { LocalLibraryStore } from '../src/adapters/content/providers/localLibraryStore';

async function seedStore(): Promise<{ store: LocalLibraryStore; tempDir: string }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lox-audioserver-libstore-delete-'));
  const dbPath = path.join(tempDir, 'library.db');
  const store = new LocalLibraryStore({ dbPath });
  await store.init();

  store.insertTrack({
    storageId: 'local',
    relPath: 'local/Artist A/Album A/01.mp3',
    title: 'Track 1',
    album: 'Album A',
    artist: 'Artist A',
    audiopath: 'library:local:track:a1',
    cover: undefined,
    mtime: undefined,
    size: undefined,
    duration: undefined,
  });
  store.insertTrack({
    storageId: 'local',
    relPath: 'local/Artist A/Album A/02.mp3',
    title: 'Track 2',
    album: 'Album A',
    artist: 'Artist A',
    audiopath: 'library:local:track:a2',
    cover: undefined,
    mtime: undefined,
    size: undefined,
    duration: undefined,
  });
  store.insertTrack({
    storageId: 'local',
    relPath: 'local/Artist A/Album B/03.mp3',
    title: 'Track 3',
    album: 'Album B',
    artist: 'Artist A',
    audiopath: 'library:local:track:a3',
    cover: undefined,
    mtime: undefined,
    size: undefined,
    duration: undefined,
  });
  store.insertTrack({
    storageId: 'local',
    relPath: 'local/Artist B/Album C/04.mp3',
    title: 'Track 4',
    album: 'Album C',
    artist: 'Artist B',
    audiopath: 'library:local:track:b1',
    cover: undefined,
    mtime: undefined,
    size: undefined,
    duration: undefined,
  });

  return { store, tempDir };
}

test('local library store: delete track by audiopath', async () => {
  const { store, tempDir } = await seedStore();
  try {
    const removed = store.deleteTracksByAudiopath('library:local:track:a1');
    assert.equal(removed, 1);
    const stats = store.getStats();
    assert.equal(stats.tracks, 3);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('local library store: delete album removes all matching tracks', async () => {
  const { store, tempDir } = await seedStore();
  try {
    const removed = store.deleteTracksForAlbum('local', 'Artist A', 'Album A');
    assert.equal(removed, 2);
    const stats = store.getStats();
    assert.equal(stats.tracks, 2);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('local library store: delete artist removes all matching tracks', async () => {
  const { store, tempDir } = await seedStore();
  try {
    const removed = store.deleteTracksForArtist('local', 'Artist A');
    assert.equal(removed, 3);
    const stats = store.getStats();
    assert.equal(stats.tracks, 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
