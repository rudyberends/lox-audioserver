import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from './testHarness';
import { makeNotifierFake } from './fakes/notifierPort';
import { LocalLibraryProvider } from '../src/adapters/content/providers/localLibraryProvider';
import { LocalLibraryStore } from '../src/adapters/content/providers/localLibraryStore';
import type { ConfigPort } from '../src/ports/ConfigPort';

const configPort: ConfigPort = {
  load: async () => {
    throw new Error('not configured');
  },
  getConfig: () => {
    throw new Error('not configured');
  },
  getSystemConfig: () => ({ audioserver: { ip: '127.0.0.1' } }) as any,
  getRawAudioConfig: () => {
    throw new Error('not configured');
  },
  ensureInputs: () => {},
  updateConfig: async () => {
    throw new Error('not configured');
  },
};

function artistKey(storageId: string, artist: string): string {
  return Buffer.from(JSON.stringify({ storageId, artist })).toString('base64url');
}

function albumKey(storageId: string, artist: string, album: string): string {
  return Buffer.from(JSON.stringify({ storageId, artist, album })).toString('base64url');
}

test('local library resolveItem fills artist/album container metadata', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lox-resolveitem-'));
  try {
    const store = new LocalLibraryStore({ dbPath: path.join(tempDir, 'library.db') });
    await store.init();
    store.insertTrack({
      storageId: 'local',
      relPath: 'music/Queen/A Night at the Opera/01 - Bohemian Rhapsody.mp3',
      title: 'Bohemian Rhapsody',
      album: 'A Night at the Opera',
      artist: 'Queen',
      audiopath: 'library:local:track:1',
      cover: 'cover.jpg',
      mtime: undefined,
      size: undefined,
      duration: 354,
    });

    // A second artist with album art but NO dedicated artist image.
    store.insertTrack({
      storageId: 'local',
      relPath: 'music/Daft Punk/Discovery/01 - One More Time.mp3',
      title: 'One More Time',
      album: 'Discovery',
      artist: 'Daft Punk',
      audiopath: 'library:local:track:2',
      cover: 'folder.jpg',
      mtime: undefined,
      size: undefined,
      duration: 320,
    });

    // Dedicated artist image (artist.jpg) sitting in the artist directory.
    store.upsertArtistCover({
      storageId: 'local',
      name: 'Queen',
      cover: 'artist.jpg',
      relPath: 'music/Queen',
    });

    const provider = new LocalLibraryProvider(makeNotifierFake(), configPort);
    (provider as unknown as { store: LocalLibraryStore }).store = store;

    const artistMeta = provider.resolveItem(`library:artist:${artistKey('local', 'Queen')}`);
    assert.equal(artistMeta?.title, 'Queen');
    // The artist's own image must win over the album cover of its first track.
    assert.ok(artistMeta?.coverurl?.includes('artist.jpg'), `expected the artist cover, got ${artistMeta?.coverurl}`);
    assert.ok(!artistMeta?.coverurl?.includes('A%20Night'), 'artist cover must not be the album cover');

    // No artist.jpg for Daft Punk → fall back to the first track's album cover.
    const fallbackArtist = provider.resolveItem(`library:artist:${artistKey('local', 'Daft Punk')}`);
    assert.equal(fallbackArtist?.title, 'Daft Punk');
    assert.ok(fallbackArtist?.coverurl?.includes('folder.jpg'), `expected the album-cover fallback, got ${fallbackArtist?.coverurl}`);

    const albumMeta = provider.resolveItem(`library:album:${albumKey('local', 'Queen', 'A Night at the Opera')}`);
    assert.equal(albumMeta?.title, 'A Night at the Opera');
    assert.equal(albumMeta?.artist, 'Queen');
    assert.equal(albumMeta?.album, 'A Night at the Opera');
    assert.ok(albumMeta?.coverurl);

    // An artist with no tracks still resolves to its name (no crash), empty cover.
    const empty = provider.resolveItem(`library:artist:${artistKey('local', 'Nobody')}`);
    assert.equal(empty?.title, 'Nobody');
    assert.equal(empty?.coverurl, '');

    // A plain track audiopath still resolves through the original path.
    const trackMeta = provider.resolveItem('library:local:track:1');
    assert.equal(trackMeta?.title, 'Bohemian Rhapsody');
    assert.equal(trackMeta?.artist, 'Queen');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
