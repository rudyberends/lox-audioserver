import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from './testHarness';
import { LocalLibraryStore } from '../src/adapters/content/providers/localLibraryStore';

async function harness(): Promise<{ store: LocalLibraryStore; tempDir: string; file: string }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sonn-core-libstore-format-'));
  const store = new LocalLibraryStore({ dbPath: path.join(tempDir, 'library.db') });
  await store.init();
  const file = path.join(tempDir, 'track.flac');
  await fs.writeFile(file, 'not really audio, but it has a size and an mtime');
  return { store, tempDir, file };
}

async function insert(
  store: LocalLibraryStore,
  file: string,
  format: Parameters<LocalLibraryStore['insertTrack']>[0]['format'],
): Promise<void> {
  const stat = await fs.stat(file);
  store.insertTrack({
    storageId: 'local',
    relPath: 'local/track.flac',
    title: 'Track',
    album: 'Album',
    artist: 'Artist',
    audiopath: 'library:local:track:1',
    // better-sqlite3 binds by name, so every parameter the statement mentions has to be present.
    cover: undefined,
    duration: undefined,
    // Written exactly as the scanner writes them; the staleness check compares against these.
    mtime: Math.floor(stat.mtimeMs),
    size: stat.size,
    format,
  });
}

test('a scanned format round-trips, so a matching file can take the bypass', async () => {
  const { store, tempDir, file } = await harness();
  await insert(store, file, {
    codec: 'flac',
    sampleRate: 44100,
    channels: 2,
    bitDepth: 16,
    lossless: true,
  });
  assert.deepEqual(store.getSourceFormat('local/track.flac', file), {
    codec: 'flac',
    sampleRate: 44100,
    channels: 2,
    bitDepth: 16,
    lossless: true,
  });
  store.close?.();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('a lossy track reports no depth rather than inventing one', async () => {
  const { store, tempDir, file } = await harness();
  await insert(store, file, {
    codec: 'mp3',
    sampleRate: 44100,
    channels: 2,
    bitDepth: null,
    lossless: false,
  });
  const format = store.getSourceFormat('local/track.flac', file);
  assert.equal(format?.bitDepth, null, 'there is no original depth to preserve');
  assert.equal(format?.lossless, false);
  store.close?.();
  await fs.rm(tempDir, { recursive: true, force: true });
});

/*
 * The whole point of the staleness check. A declared format that no longer describes the file is
 * worse than none: `isBitPerfect` would clear its guard, the filter chain would be left empty, and
 * ffmpeg would insert its own resampler with default options — a silent conversion in place of the
 * described one. Null puts us back on the old behaviour, which is merely a needless resample.
 */
test('a file re-encoded in place since the scan reads as undeclared', async () => {
  const { store, tempDir, file } = await harness();
  await insert(store, file, {
    codec: 'flac',
    sampleRate: 44100,
    channels: 2,
    bitDepth: 16,
    lossless: true,
  });
  assert.ok(store.getSourceFormat('local/track.flac', file), 'sanity: believed to begin with');

  await fs.writeFile(file, 'the same path, a different file — 96/24 now, for all we know');
  assert.equal(store.getSourceFormat('local/track.flac', file), null);

  // Without a path to check against there is nothing to compare, and the row is taken at its word.
  assert.ok(store.getSourceFormat('local/track.flac'));
  store.close?.();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('a track scanned before the format columns existed simply has none', async () => {
  const { store, tempDir, file } = await harness();
  await insert(store, file, null);
  assert.equal(store.getSourceFormat('local/track.flac', file), null);
  assert.equal(store.getSourceFormat('local/nope.flac', file), null);
  store.close?.();
  await fs.rm(tempDir, { recursive: true, force: true });
});
