import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from './testHarness';
import type { StreamingServiceConfig } from '../src/domain/config/types';
import { YtMusicProvider } from '../src/adapters/content/providers/ytmusic/ytmusicProvider';
import { YtMusicStreamService } from '../src/adapters/content/providers/ytmusic/ytmusicStreamService';
import { toProviderNode } from '../src/adapters/loxone/commands/utils/loxoneServiceFolders';

// Ensure offline tests always use the repo-local yt-dlp mock (instead of the system yt-dlp).
// Named outright rather than left to PATH order: a real yt-dlp downloaded through the
// admin UI lives in `data/` and is preferred over PATH, which would otherwise take these
// tests onto the network without saying so.
const scriptsDir = path.resolve(__dirname, '..', 'scripts');
process.env.PATH = `${scriptsDir}:${process.env.PATH ?? ''}`;
process.env.YTDLP_BIN = path.join(scriptsDir, 'yt-dlp');

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

test('ytmusic native: provider folder root exposes its sections by name', async () => {
  const bridge = makeBridge('bridge-ytmusic-test');
  const provider = new YtMusicProvider({ providerId: `spotify@${bridge.id}`, bridge });
  const folder = await provider.getFolder('root', 0, 50);
  assert.ok(folder);
  // The root publishes node names; the Loxone app's slot indices are mapped onto
  // these by its adapter (see loxoneServiceFolders.test.ts).
  assert.ok(folder?.items?.some((i) => i.id === 'playlists'));
  assert.ok(folder?.items?.some((i) => i.id === 'artists'));
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

test("ytmusic native: the Loxone app's artists slot still reaches the artists folder", async () => {
  const bridge = makeBridge('bridge-ytmusic-test');
  const provider = new YtMusicProvider({ providerId: `spotify@${bridge.id}`, bridge });
  // What the Loxone adapter does with slot 6 before the provider ever sees it.
  const folder = await provider.getFolder(toProviderNode('spotify', bridge.id, '6'), 0, 50);
  assert.ok(folder);
  assert.equal(folder?.name, 'Artists');
  assert.ok(Array.isArray(folder?.items));
});

// A second account of the same service puts its slug in the audiopath
// (`ytmusic:1ryw2i:playlist:…` instead of `ytmusic:playlist:…`). The provider used to
// match `^playlist:` against that, recognise nothing, and hand back an empty folder —
// so every playlist, album and track opened blank for anyone with two accounts.
test('ytmusic native: a second account still opens its playlists and albums', async () => {
  const bridge = { ...makeBridge('bridge-ytmusic-1ryw2i'), ytmusicCookie: 'SID=mock' };
  const provider = new YtMusicProvider({
    providerId: `spotify@${bridge.id}`,
    serviceNativePrefix: 'ytmusic:1ryw2i',
    bridge,
  });

  const playlist = await provider.getFolder('ytmusic:1ryw2i:playlist:VLPLakrH01Ik-_U', 0, 50);
  assert.ok((playlist?.items?.length ?? 0) > 0, 'playlist of a second account came back empty');

  const track = await provider.getFolder('ytmusic:1ryw2i:track:dQw4w9WgXcQ', 0, 50);
  assert.equal(track?.items?.length, 1);

  // The single-account form keeps working: `playlist` is a kind, not an account.
  const single = await provider.getFolder('ytmusic:playlist:VLPLakrH01Ik-_U', 0, 50);
  assert.equal(single?.items?.length, playlist?.items?.length);
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
