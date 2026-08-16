import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from './testHarness';
import { createRecentsManager } from '../src/application/zones/recents/recentsManager';
import { buildBridgeRegistry } from '../src/domain/zones/bridgeIdentity';

// No bridged services configured: `normalizeForClient` asks for the registry to put the Loxone
// envelope back on a bridged path, and an empty one leaves every path as it is.
const EMPTY_REGISTRY = buildBridgeRegistry([]);

async function withTempCwd(fn: () => Promise<void>): Promise<void> {
  const originalCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lox-recents-test-'));
  process.chdir(tempDir);
  try {
    await fn();
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test('recents manager normalizes local library items to client-compatible audiopath', async () => {
  await withTempCwd(async () => {
    await fs.mkdir(path.join(process.cwd(), 'data', 'recents'), { recursive: true });
    await fs.writeFile(
      path.join(process.cwd(), 'data', 'recents', '27.json'),
      JSON.stringify({
        ts: 1,
        items: [
          {
            audiopath: 'library://local/Ed_Sheeran_-_Play/03_Azizam.mp3',
            coverurl: '',
            owner: 'nouser',
            owner_id: 'nouser',
            service: 'library',
            serviceType: 2,
            title: 'Azizam',
            type: 2,
            album: 'Play',
            artist: 'Ed Sheeran',
          },
        ],
      }),
    );

    const recentsManager = createRecentsManager({
      notifier: { notifyRecentlyPlayedChanged: () => {} } as any,
      contentPort: { getDefaultSpotifyAccountId: () => null, getBridgeRegistry: () => EMPTY_REGISTRY } as any,
    });

    const result = await recentsManager.get(27);
    assert.match(result.items[0]?.audiopath ?? '', /^library:local:track:b64_/);
  });
});

test('recents manager maps legacy custom radio service to custom_stream', async () => {
  await withTempCwd(async () => {
    await fs.mkdir(path.join(process.cwd(), 'data', 'recents'), { recursive: true });
    await fs.writeFile(
      path.join(process.cwd(), 'data', 'recents', '15.json'),
      JSON.stringify({
        ts: 1,
        items: [
          {
            audiopath: 'https://example.com/radio.mp3',
            coverurl: '',
            owner: 'nouser',
            owner_id: 'nouser',
            service: 'custom',
            serviceType: 3,
            title: 'Web Radio',
            type: 3,
          },
        ],
      }),
    );

    const recentsManager = createRecentsManager({
      notifier: { notifyRecentlyPlayedChanged: () => {} } as any,
      contentPort: { getDefaultSpotifyAccountId: () => null, getBridgeRegistry: () => EMPTY_REGISTRY } as any,
    });

    const result = await recentsManager.get(15);
    assert.equal(result.items[0]?.service, 'custom_stream');
  });
});

test('a bridged track is recorded under its own identity, not doubled behind an account', async () => {
  await withTempCwd(async () => {
    const recentsManager = createRecentsManager({
      notifier: { notifyRecentlyPlayedChanged: () => {} } as any,
      contentPort: {
        getDefaultSpotifyAccountId: () => 'md123121',
        resolveMetadata: async () => null,
        getBridgeRegistry: () => EMPTY_REGISTRY,
      } as any,
    });

    // `resolveService` answers `spotify` for every bridged service — that is the Loxone view.
    // It must not decide that this path wants a Spotify account glued in front of it: doing so
    // stored `spotify@applemusic:applemusic:track:…`, which is what the readers downstream
    // have a special case for.
    await recentsManager.record(27, {
      audiopath: 'applemusic:track:b64_MTc5MTg4MzY2Nw==',
      user: 'applemusic',
      title: 'Something',
    } as any);

    const stored = await recentsManager.get(27);
    assert.equal(stored.items[0]?.audiopath, 'applemusic:track:b64_MTc5MTg4MzY2Nw==');
  });
});

test('a real Spotify track still gets its account', async () => {
  await withTempCwd(async () => {
    const recentsManager = createRecentsManager({
      notifier: { notifyRecentlyPlayedChanged: () => {} } as any,
      contentPort: {
        getDefaultSpotifyAccountId: () => 'md123121',
        resolveMetadata: async () => null,
        getBridgeRegistry: () => EMPTY_REGISTRY,
      } as any,
    });

    await recentsManager.record(27, {
      audiopath: 'spotify:track:2bJtJv5NGkYUFP6prU3WSg',
      user: 'nouser',
      title: 'Something',
    } as any);

    const stored = await recentsManager.get(27);
    assert.equal(stored.items[0]?.audiopath, 'spotify@md123121:track:2bJtJv5NGkYUFP6prU3WSg');
  });
});
