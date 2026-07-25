import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from './testHarness';
import type { StreamingServiceConfig } from '../src/domain/config/types';
import { YtMusicProvider } from '../src/adapters/content/providers/ytmusic/ytmusicProvider';
import { YtMusicStreamService } from '../src/adapters/content/providers/ytmusic/ytmusicStreamService';

// Ensure offline tests always use the repo-local yt-dlp mock (instead of the system yt-dlp).
const scriptsDir = path.resolve(__dirname, '..', 'scripts');
process.env.PATH = `${scriptsDir}:${process.env.PATH ?? ''}`;

function makeBridge(id: string): StreamingServiceConfig {
  return {
    id,
    label: 'YouTube Music (Mock)',
    provider: 'ytmusic',
    enabled: true,
    registerAll: true,
  };
}

test('ytmusic native: provider search uses yt-dlp and returns tracks', async () => {
  const bridge = makeBridge('bridge-ytmusic-test');
  const provider = new YtMusicProvider({ providerId: `spotify@${bridge.id}`, bridge });
  const res = await provider.search('hello', { tracks: 3 }, 10);
  assert.ok(Array.isArray(res.result.tracks));
  assert.ok((res.result.tracks?.length ?? 0) >= 3);
  assert.ok(res.result.tracks?.[0]?.audiopath?.includes('spotify@bridge-ytmusic-test:track:'));
});

test('ytmusic native: provider folder root exposes liked songs', async () => {
  const bridge = makeBridge('bridge-ytmusic-test');
  const provider = new YtMusicProvider({ providerId: `spotify@${bridge.id}`, bridge });
  const folder = await provider.getFolder('root', 0, 50);
  assert.ok(folder);
  assert.ok(folder?.items?.some((i) => i.id === '3'));
});

test('ytmusic native: provider liked songs expands playlist LM', async () => {
  const bridge = { ...makeBridge('bridge-ytmusic-test'), ytmusicCookie: 'SID=mock' };
  const provider = new YtMusicProvider({ providerId: `spotify@${bridge.id}`, bridge });
  const folder = await provider.getFolder('liked', 0, 5);
  assert.ok(folder);
  assert.ok(Array.isArray(folder?.items));
  assert.ok((folder?.items?.length ?? 0) > 0);
  const first = folder?.items?.[0];
  assert.ok(typeof first?.audiopath === 'string' && first.audiopath.includes(':track:'));
});

test('ytmusic native: numeric folder id 6 (artists) resolves to the artists folder', async () => {
  const bridge = makeBridge('bridge-ytmusic-test');
  const provider = new YtMusicProvider({ providerId: `spotify@${bridge.id}`, bridge });
  const folder = await provider.getFolder('6', 0, 50);
  assert.ok(folder);
  assert.equal(folder?.name, 'Artists');
  assert.ok(Array.isArray(folder?.items));
});

test('ytmusic native: stream service resolves a direct url via yt-dlp', async () => {
  const bridge = makeBridge('bridge-ytmusic-test');
  const providerId = `spotify@${bridge.id}`;

  const configPort = {
    getConfig: () => ({
      content: { streamingServices: [bridge] },
    }),
  } as any;

  let lastError: string | undefined;
  const streamService = new YtMusicStreamService((_zoneId, reason) => {
    lastError = reason;
  }, configPort);
  streamService.configureFromConfig();

  const res = await streamService.startStreamForAudiopath(1, `${providerId}:track:dQw4w9WgXcQ`);
  assert.equal(lastError, undefined);
  assert.ok(res.playbackSource);
  assert.equal(res.playbackSource?.kind, 'url');
  assert.ok(typeof (res.playbackSource as any).url === 'string');
});
