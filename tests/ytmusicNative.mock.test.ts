import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from './testHarness';
import type { StreamingServiceConfig } from '../src/domain/config/types';
import { YtMusicProvider } from '../src/adapters/content/providers/ytmusic/ytmusicProvider';
import { YtMusicStreamService } from '../src/adapters/content/providers/ytmusic/ytmusicStreamService';
import { toProviderNode } from '../src/adapters/loxone/commands/utils/loxoneServiceFolders';
import {
  YtMusicCookieExpiredError,
  isSignedOutResponse,
} from '../src/adapters/content/providers/ytmusic/ytmusicInnertube';
import { getYtMusicAuthStatus } from '../src/adapters/content/providers/ytmusic/ytmusicAuthState';
import { providerDefinition } from '../src/adapters/content/providerRegistry';

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

// --- cookie expiry (issue #364) -------------------------------------------------
//
// YouTube does not fail a request made with a dead cookie: it answers 200 with a
// body that has a "Sign in" prompt where the library should be. That made an
// expired cookie indistinguishable from an empty library, which is why it went
// unreported for as long as it did. These pin the signal down.

test('ytmusic native: a sign-in prompt in a browse response reads as an expired cookie', () => {
  // Shape taken from a real response to an expired cookie: 200, no
  // mainAppWebResponseContext, and a signInEndpoint behind a "Sign in" button.
  const signedOut = {
    responseContext: { visitorData: 'abc', responseId: 'xyz' },
    contents: {
      messageRenderer: {
        text: { runs: [{ text: 'Sign in' }] },
        navigationEndpoint: { signInEndpoint: { hack: true } },
      },
    },
  };
  assert.equal(isSignedOutResponse(signedOut), true);
});

test('ytmusic native: a signed-in browse response is never called expired', () => {
  const signedIn = {
    responseContext: { mainAppWebResponseContext: { loggedOut: false } },
    contents: { musicShelfRenderer: { contents: [{ musicTwoRowItemRenderer: {} }] } },
  };
  assert.equal(isSignedOutResponse(signedIn), false);

  // `loggedOut: false` wins even if a sign-in endpoint turns up somewhere in the
  // payload: the response positively states who it belongs to.
  const signedInWithPrompt = {
    responseContext: { mainAppWebResponseContext: { loggedOut: false } },
    contents: { footer: { navigationEndpoint: { signInEndpoint: {} } } },
  };
  assert.equal(isSignedOutResponse(signedInWithPrompt), false);

  // And an ordinary empty library stays empty rather than becoming "expired".
  assert.equal(isSignedOutResponse({ responseContext: {}, contents: {} }), false);
});

test('ytmusic native: an expired cookie is recorded, not just logged', async () => {
  const bridge = { ...makeBridge('bridge-ytmusic-expired'), ytmusicCookie: 'SID=dead' };
  const provider = new YtMusicProvider({
    providerId: `spotify@${bridge.id}`,
    bridge,
    browse: async () => {
      throw new YtMusicCookieExpiredError();
    },
  });

  assert.equal(getYtMusicAuthStatus(bridge.id).state, 'unknown');
  const folder = await provider.getFolder('albums', 0, 50);
  // The section still fails softly — an empty list is right for a section that
  // could not load — but the reason is now recoverable.
  assert.equal(folder?.items?.length ?? 0, 0);
  assert.equal(getYtMusicAuthStatus(bridge.id).state, 'expired');
});

test('ytmusic native: a cookie that works marks the account healthy', async () => {
  const bridge = { ...makeBridge('bridge-ytmusic-healthy'), ytmusicCookie: 'SID=mock' };
  const provider = new YtMusicProvider({
    providerId: `spotify@${bridge.id}`,
    bridge,
    browse: async () => ({
      responseContext: { mainAppWebResponseContext: { loggedOut: false } },
      contents: {},
    }),
  });

  await provider.getFolder('albums', 0, 50);
  assert.equal(getYtMusicAuthStatus(bridge.id).state, 'ok');
});

test('ytmusic native: a dead PO Token server must not take playback down', async () => {
  // The PO Token path is an upgrade, never a dependency: a url left configured
  // after the helper service stopped has to fall back, not fail.
  const bridge = {
    ...makeBridge('bridge-ytmusic-potdown'),
    ytmusicCookie: 'SID=mock',
    ytmusicPoTokenUrl: 'http://127.0.0.1:1',
  };
  const providerId = `spotify@${bridge.id}`;
  const configPort = { getConfig: () => ({ content: { streamingServices: [bridge] } }) } as any;

  let lastError: string | undefined;
  const streamService = new YtMusicStreamService((_zoneId, reason) => {
    lastError = reason;
  }, configPort);
  streamService.configureFromConfig();

  const res = await streamService.startStreamForAudiopath(1, `${providerId}:track:dQw4w9WgXcQ`);
  assert.equal(lastError, undefined);
  assert.equal(res.playbackSource?.kind, 'url');
});

test('ytmusic native: registering an account settles its cookie verdict', async () => {
  // The verdict has to exist before anyone browses, or a fresh server has nothing to
  // report and the service list looks healthy while the library is empty. Registration
  // is where that check is kicked off, so this pins the wiring rather than the request.
  const definition = providerDefinition('ytmusic');
  assert.ok(definition);

  const bridge = makeBridge('bridge-ytmusic-registered');
  assert.equal(getYtMusicAuthStatus(bridge.id).state, 'unknown');
  definition!.create({
    providerId: `spotify@${bridge.id}`,
    serviceNativePrefix: 'ytmusic',
    label: 'YouTube Music',
    bridge,
  });

  // No cookie configured: answered locally as "not set up", never as a request to
  // YouTube — which is also what keeps this suite offline.
  assert.equal(getYtMusicAuthStatus(bridge.id).state, 'missing');
});
