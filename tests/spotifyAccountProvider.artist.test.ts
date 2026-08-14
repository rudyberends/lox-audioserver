import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SpotifyAccountProvider } from '../src/adapters/content/providers/spotify/spotifyAccountProvider';

/**
 * An artist page used to be pathfinder-only, so when an account could not open a librespot
 * session every artist under `Artists` — the artists the user follows, no less — opened onto
 * nothing. The ordinary Web API endpoints answer without that session, and this pins that they
 * are used, including the grouping a consumer needs to tell popular tracks from records.
 *
 * The account here deliberately has no `librespotCredentials`, which is exactly the state that
 * made the folder empty: pathfinder is skipped and the fallback has to carry the page.
 */
test('an artist page falls back to the Web API when there is no librespot session', async () => {
  const originalFetch = global.fetch;
  const artistId = '0Ty63ceoRnnJKVEYP0VQpk';

  global.fetch = (async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());

    if (url.pathname === `/v1/artists/${artistId}/top-tracks`) {
      // The market comes from the account's country — without it Spotify answers no tracks.
      assert.equal(url.searchParams.get('market'), 'NL');
      return new Response(
        JSON.stringify({
          tracks: [
            {
              id: 'track-shape',
              name: 'Shape Of My Heart',
              duration_ms: 278000,
              artists: [{ name: 'Sting' }],
              album: { name: 'Ten Summoner’s Tales', images: [] },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.pathname === `/v1/artists/${artistId}/albums`) {
      assert.equal(url.searchParams.get('include_groups'), 'album,single');
      return new Response(
        JSON.stringify({
          total: 1,
          items: [
            {
              id: 'album-mercury',
              name: 'Mercury Falling',
              total_tracks: 11,
              artists: [{ name: 'Sting' }],
              images: [],
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
      providerId: 'spotify@rudy',
      account: {
        id: 'rudy',
        user: 'rudy',
        country: 'NL',
        refreshToken: 'unused-in-test',
      },
      persistAccount: async () => null,
    });
    (provider as any).accessToken = 'test-token';
    (provider as any).tokenExpiresAt = Date.now() + 60_000;

    const folder = await provider.getFolder(`artist:${artistId}`, 0, 20);

    // Tracks first, then records — the order an artist page reads in.
    assert.deepEqual(
      (folder?.items ?? []).map((item) => item.name),
      ['Shape Of My Heart', 'Mercury Falling'],
    );
    assert.equal(folder?.totalitems, 2);

    // The track is playable and the album is a container to open, each addressed
    // service-natively so the ids survive the trip to any consumer.
    const [track, album] = folder?.items ?? [];
    assert.equal(track?.audiopath, 'spotify@rudy:track:track-shape');
    assert.equal(track?.artist, 'Sting');
    assert.equal(album?.id, 'spotify@rudy:album:album-mercury');
    assert.equal(album?.tag, 'album');

    // Grouped, so a consumer that can show shelves does not have to guess where the
    // tracks stop and the albums start.
    assert.deepEqual(
      (folder?.sections ?? []).map((section) => [section.id, section.name, section.items.length]),
      [
        ['artist-top-tracks', 'Popular', 1],
        ['artist-albums', 'Albums & singles', 1],
      ],
    );
  } finally {
    global.fetch = originalFetch;
  }
});
