import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from './testHarness';
import { makeNotifierFake } from './fakes/notifierPort';
import { LocalLibraryProvider } from '../src/adapters/content/providers/localLibraryProvider';
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

test('local library provider: exposes a drive-style folder view', async () => {
  const originalCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sonn-core-library-folders-'));
  try {
    process.chdir(tempDir);
    await fs.mkdir(path.join(tempDir, 'data', 'music', 'local', 'Various Artists', 'Sampler'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(tempDir, 'data', 'music', 'local', 'Various Artists', 'Sampler', '01 - First.mp3'),
      '',
    );

    const provider = new LocalLibraryProvider(makeNotifierFake(), configPort);
    const storage = await provider.getMediaFolder('library-local', 0, 50);
    assert.ok(storage?.items.some((item) => item.id === 'library-local-folders'));

    const folders = await provider.getMediaFolder('library-local-folders', 0, 50);
    const artistFolder = folders?.items.find((item) => item.name === 'Various Artists');
    assert.ok(artistFolder);
    assert.equal(artistFolder?.type, 1);

    const albumFolder = await provider.getMediaFolder(artistFolder!.id, 0, 50);
    const samplerFolder = albumFolder?.items.find((item) => item.name === 'Sampler');
    assert.ok(samplerFolder);
    assert.equal(samplerFolder?.type, 1);

    const tracks = await provider.getMediaFolder(samplerFolder!.id, 0, 50);
    const track = tracks?.items.find((item) => item.name === '01 - First');
    assert.ok(track);
    assert.equal(track?.type, 2);
    assert.ok(track?.audiopath?.startsWith('library:local:track:b64_'));
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
