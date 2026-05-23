import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SpotifyAccountProvider } from '../src/adapters/content/providers/spotify/spotifyAccountProvider';

test('spotify account provider keeps playlists visible and loads playlist tracks', async () => {
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

    if (path === `/v1/playlists/${playlistId}/items`) {
      return new Response(
        JSON.stringify({
          total: 1,
          items: [
            {
              track: {
                id: 'track-1',
                name: 'Track One',
                duration_ms: 180000,
                artists: [{ name: 'Artist One' }],
                album: { name: 'Album One', images: [] },
              },
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

test('spotify account provider paginates playlist tracks beyond offset 50 (issue #200)', async () => {
  const originalFetch = global.fetch;
  const playlistId = '3CEIZD3u8XdpjR5Y3X6kZw';
  const seenRequests: Array<{ offset: string | null; limit: string | null }> = [];

  global.fetch = (async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname;

    if (path === `/v1/playlists/${playlistId}/items`) {
      const offset = url.searchParams.get('offset');
      const limit = url.searchParams.get('limit');
      seenRequests.push({ offset, limit });
      const start = Number(offset) || 0;
      const count = Math.min(Number(limit) || 50, 200 - start);
      const items = Array.from({ length: Math.max(0, count) }, (_, i) => ({
        track: {
          id: `track-${start + i}`,
          name: `Track ${start + i}`,
          duration_ms: 180000,
          artists: [{ name: 'Artist' }],
          album: { name: 'Album', images: [] },
        },
      }));
      return new Response(JSON.stringify({ total: 200, items }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
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

    const firstPage = await provider.getFolder(`spotify@Bianca:playlist:${playlistId}`, 0, 50);
    assert.ok(firstPage);
    assert.equal(firstPage?.items?.length, 50);
    assert.equal(firstPage?.totalitems, 200);
    assert.equal(firstPage?.items?.[0]?.name, 'Track 0');

    const secondPage = await provider.getFolder(`spotify@Bianca:playlist:${playlistId}`, 50, 50);
    assert.ok(secondPage);
    assert.equal(secondPage?.items?.length, 50);
    assert.equal(secondPage?.items?.[0]?.name, 'Track 50');
    assert.equal(secondPage?.items?.[49]?.name, 'Track 99');

    assert.deepEqual(seenRequests, [
      { offset: '0', limit: '50' },
      { offset: '50', limit: '50' },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('spotify account provider chunks playlist tracks above the 50-item Spotify cap', async () => {
  const originalFetch = global.fetch;
  const playlistId = 'big-playlist';
  const seenRequests: Array<{ offset: number; limit: number }> = [];

  global.fetch = (async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname;

    if (path === `/v1/playlists/${playlistId}/items`) {
      const offset = Number(url.searchParams.get('offset')) || 0;
      const limit = Number(url.searchParams.get('limit')) || 0;
      seenRequests.push({ offset, limit });
      const count = Math.min(limit, 300 - offset);
      const items = Array.from({ length: Math.max(0, count) }, (_, i) => ({
        track: {
          id: `track-${offset + i}`,
          name: `Track ${offset + i}`,
          duration_ms: 180000,
          artists: [{ name: 'Artist' }],
          album: { name: 'Album', images: [] },
        },
      }));
      return new Response(JSON.stringify({ total: 300, items }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
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

    const folder = await provider.getFolder(`spotify@Bianca:playlist:${playlistId}`, 0, 130);
    assert.ok(folder);
    assert.equal(folder?.items?.length, 130);
    assert.equal(folder?.totalitems, 300);
    assert.equal(folder?.items?.[0]?.name, 'Track 0');
    assert.equal(folder?.items?.[50]?.name, 'Track 50');
    assert.equal(folder?.items?.[129]?.name, 'Track 129');

    assert.deepEqual(seenRequests, [
      { offset: 0, limit: 50 },
      { offset: 50, limit: 50 },
      { offset: 100, limit: 30 },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('spotify account provider keeps followed and public playlists from /me/playlists', async () => {
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
    assert.equal(playlists?.items?.length, 2);
    assert.equal(playlists?.totalitems, 2);
    assert.deepEqual(
      playlists?.items?.map((item) => item.name),
      ['Own Playlist', 'Public Playlist'],
    );
  } finally {
    global.fetch = originalFetch;
  }
});
