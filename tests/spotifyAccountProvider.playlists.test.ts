import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SpotifyAccountProvider } from '../src/adapters/content/providers/spotify/spotifyAccountProvider';

test('spotify account provider keeps playlists visible and parses nested playlist items payload', async () => {
  const originalFetch = global.fetch;
  const playlistId = '1MQmPhKcSH2XoZPnRo8EHE';

  global.fetch = (async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname;

    if (path === '/v1/me/playlists') {
      return new Response(
        JSON.stringify({
          items: [
            {
              id: playlistId,
              name: 'My Playlist',
              owner: { id: 'bianca' },
              tracks: { total: 1 },
            },
          ],
          total: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (path === `/v1/playlists/${playlistId}`) {
      return new Response(
        JSON.stringify({
          id: playlistId,
          items: {
            total: 1,
            items: [
              {
                item: {
                  id: 'track-1',
                  name: 'Track One',
                  duration_ms: 180000,
                  artists: [{ name: 'Artist One' }],
                  album: { name: 'Album One', images: [] },
                },
              },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response(JSON.stringify({ error: 'unexpected-url', url: url.toString() }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const provider = new SpotifyAccountProvider({
      providerId: 'spotify@Bianca',
      account: {
        id: 'Bianca',
        spotifyId: 'bianca',
        user: 'Bianca',
        refreshToken: 'unused-in-test',
      },
      persistAccount: async () => null,
    });

    (provider as any).accessToken = 'test-token';
    (provider as any).tokenExpiresAt = Date.now() + 60_000;

    const playlistsBefore = await provider.getFolder('playlists', 0, 20);
    assert.ok(playlistsBefore);
    assert.equal(playlistsBefore?.items?.length, 1);
    assert.equal(playlistsBefore?.items?.[0]?.name, 'My Playlist');

    const tracksFolder = await provider.getFolder(`spotify@Bianca:playlist:${playlistId}`, 0, 50);
    assert.ok(tracksFolder);
    assert.equal(tracksFolder?.items?.length, 1);
    assert.equal(tracksFolder?.items?.[0]?.name, 'Track One');

    const playlistsAfter = await provider.getFolder('playlists', 0, 20);
    assert.ok(playlistsAfter);
    assert.equal(playlistsAfter?.items?.length, 1);
    assert.equal(playlistsAfter?.items?.[0]?.name, 'My Playlist');
  } finally {
    global.fetch = originalFetch;
  }
});

test('spotify account provider parses public playlist payload with direct items array', async () => {
  const originalFetch = global.fetch;
  const playlistId = '3CEIZD3u8XdpjR5Y3X6kZw';

  global.fetch = (async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname;

    if (path === '/v1/me/playlists') {
      return new Response(JSON.stringify({ items: [], total: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (path === `/v1/playlists/${playlistId}`) {
      return new Response(
        JSON.stringify({
          id: playlistId,
          items: [
            {
              id: 'track-public-1',
              name: 'Public Track One',
              duration_ms: 201000,
              artists: [{ name: 'Public Artist' }],
              album: { name: 'Public Album', images: [] },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response(JSON.stringify({ error: 'unexpected-url', url: url.toString() }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const provider = new SpotifyAccountProvider({
      providerId: 'spotify@Bianca',
      account: {
        id: 'Bianca',
        spotifyId: 'bianca',
        user: 'Bianca',
        refreshToken: 'unused-in-test',
      },
      persistAccount: async () => null,
    });

    (provider as any).accessToken = 'test-token';
    (provider as any).tokenExpiresAt = Date.now() + 60_000;

    const tracksFolder = await provider.getFolder(`spotify@Bianca:playlist:${playlistId}`, 0, 50);
    assert.ok(tracksFolder);
    assert.equal(tracksFolder?.items?.length, 1);
    assert.equal(tracksFolder?.items?.[0]?.name, 'Public Track One');
  } finally {
    global.fetch = originalFetch;
  }
});

test('spotify account provider filters out playlists not owned by the account', async () => {
  const originalFetch = global.fetch;

  global.fetch = (async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname;

    if (path === '/v1/me/playlists') {
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'own-1',
              name: 'Own Playlist',
              owner: { id: 'bianca' },
              tracks: { total: 1 },
            },
            {
              id: 'public-1',
              name: 'Public Playlist',
              owner: { id: 'spotify' },
              tracks: { total: 200 },
            },
          ],
          total: 2,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response(JSON.stringify({ error: 'unexpected-url', url: url.toString() }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const provider = new SpotifyAccountProvider({
      providerId: 'spotify@Bianca',
      account: {
        id: 'Bianca',
        spotifyId: 'bianca',
        user: 'Bianca',
        refreshToken: 'unused-in-test',
      },
      persistAccount: async () => null,
    });

    (provider as any).accessToken = 'test-token';
    (provider as any).tokenExpiresAt = Date.now() + 60_000;

    const playlists = await provider.getFolder('playlists', 0, 20);
    assert.ok(playlists);
    assert.equal(playlists?.items?.length, 1);
    assert.equal(playlists?.totalitems, 1);
    assert.equal(playlists?.items?.[0]?.name, 'Own Playlist');
  } finally {
    global.fetch = originalFetch;
  }
});
