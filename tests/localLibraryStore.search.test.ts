import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
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

test('local library store: groups albums by album artist', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lox-audioserver-libstore-album-artist-'));
  const dbPath = path.join(tempDir, 'library.db');

  const store = new LocalLibraryStore({ dbPath });
  await store.init();

  try {
    store.insertTrack({
      storageId: 'local',
      relPath: 'music/Various Artists/Studio Brussel/01 - Artist A.mp3',
      title: 'Track A',
      album: 'Studio Brussel',
      artist: 'Artist A',
      albumArtist: 'Various Artists',
      audiopath: 'library:local:track:a',
      cover: undefined,
      mtime: undefined,
      size: undefined,
      duration: undefined,
    });
    store.insertTrack({
      storageId: 'local',
      relPath: 'music/Various Artists/Studio Brussel/02 - Artist B.mp3',
      title: 'Track B',
      album: 'Studio Brussel',
      artist: 'Artist B',
      albumArtist: 'Various Artists',
      audiopath: 'library:local:track:b',
      cover: undefined,
      mtime: undefined,
      size: undefined,
      duration: undefined,
    });

    const stats = store.getStats();
    assert.equal(stats.albums, 1);
    assert.equal(stats.artists, 2);

    const albums = store.getAlbums('local', 0, 10);
    assert.equal(albums.total, 1);
    assert.equal(albums.items[0]?.artist, 'Various Artists');
    assert.equal(albums.items[0]?.track_count, 2);

    const tracks = store.getTracksForAlbum('local', 'Various Artists', 'Studio Brussel', 0, 10);
    assert.equal(tracks.total, 2);
    assert.deepEqual(tracks.items.map((track) => track.artist).sort(), ['Artist A', 'Artist B']);

    const searchAlbums = store.searchAlbums('various', 10);
    assert.equal(searchAlbums.length, 1);
    assert.equal(searchAlbums[0]?.track_count, 2);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('local library store: migrates legacy database before creating album artist index', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lox-audioserver-libstore-legacy-'));
  const dbPath = path.join(tempDir, 'library.db');

  try {
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        storage_id TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        title TEXT NOT NULL,
        album TEXT NOT NULL,
        artist TEXT NOT NULL,
        audiopath TEXT NOT NULL,
        cover TEXT,
        mtime INTEGER,
        size INTEGER,
        duration REAL,
        UNIQUE(storage_id, rel_path)
      );
      INSERT INTO tracks (storage_id, rel_path, title, album, artist, audiopath)
      VALUES ('local', 'local/Artist/Album/01.mp3', 'Track', 'Album', 'Artist', 'library:local:track:legacy');
      PRAGMA user_version = 2;
    `);
    legacy.close();

    const store = new LocalLibraryStore({ dbPath });
    await store.init();

    const stats = store.getStats();
    assert.equal(stats.tracks, 1);
    assert.equal(stats.albums, 1);
    const tracks = store.getTracks('local', 0, 10);
    assert.equal(tracks.items[0]?.album_artist, 'Artist');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
