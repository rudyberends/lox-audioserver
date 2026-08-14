import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  webPathfinderSession,
  resetWebTokenCache,
} from '../src/adapters/content/providers/spotify/spotifyWebTokens';
import { SpotifyAccountProvider } from '../src/adapters/content/providers/spotify/spotifyAccountProvider';

const CLIENT_TOKEN = 'AAF7P3Pfcftx34URph-minted-client-token';
const BEARER = 'BQBxrrWPHl6NKxWMZGqQ-scraped-bearer';
const HASH = 'a'.repeat(64);

/** An embed page as Spotify serves it: server-rendered, with the session in `__NEXT_DATA__`. */
function embedPage(token: string, expiresInMs = 3 * 3_600_000): string {
  const payload = {
    props: {
      pageProps: {
        state: {
          settings: { session: {
            accessToken: token,
            accessTokenExpirationTimestampMs: Date.now() + expiresInMs,
            isAnonymous: true,
          } },
        },
      },
    },
  };
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></body></html>`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Route the three hosts the token pair comes from, counting hits so caching can be asserted.
 * Anything unrouted answers 404 loudly, so a new dependency shows up as a failure rather than as
 * a silent empty result.
 */
function stubTokenHosts() {
  const hits = { clientToken: 0, embed: 0 };
  const original = global.fetch;
  global.fetch = (async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (url.hostname === 'clienttoken.spotify.com') {
      hits.clientToken++;
      return json({
        response_type: 'RESPONSE_GRANTED_TOKEN_RESPONSE',
        granted_token: { token: CLIENT_TOKEN, expires_after_seconds: 1_216_800, refresh_after_seconds: 1_209_600 },
      });
    }
    if (url.hostname === 'open.spotify.com' && url.pathname.startsWith('/embed/')) {
      hits.embed++;
      return new Response(embedPage(BEARER), {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    return new Response(`unrouted ${url.toString()}`, { status: 404 });
  }) as typeof fetch;
  return { hits, restore: () => { global.fetch = original; } };
}

test('web tokens are minted from the client-token endpoint and a public embed page', async () => {
  resetWebTokenCache();
  const { hits, restore } = stubTokenHosts();
  try {
    const tokens = await webPathfinderSession.getTokens();
    assert.equal(tokens.accessToken, BEARER);
    assert.equal(tokens.tokenType, 'Bearer');
    assert.equal(tokens.clientToken, CLIENT_TOKEN);
    assert.ok(tokens.expiresInMs > 0, 'a usable lifetime');
    assert.deepEqual(hits, { clientToken: 1, embed: 1 });

    // Cached until they lapse. Without this a single root browse — which fans out into
    // several pathfinder calls — would re-mint the pair for each one.
    await webPathfinderSession.getTokens();
    await webPathfinderSession.getTokens();
    assert.deepEqual(hits, { clientToken: 1, embed: 1 }, 'no re-minting while fresh');
  } finally {
    restore();
    resetWebTokenCache();
  }
});

test('a cold cache asked twice at once mints one pair, not two', async () => {
  resetWebTokenCache();
  const { hits, restore } = stubTokenHosts();
  try {
    await Promise.all([
      webPathfinderSession.getTokens(),
      webPathfinderSession.getTokens(),
      webPathfinderSession.getTokens(),
    ]);
    assert.deepEqual(hits, { clientToken: 1, embed: 1 });
  } finally {
    restore();
    resetWebTokenCache();
  }
});

test('getTokens fails rather than half-answers when a source is down', async () => {
  resetWebTokenCache();
  const original = global.fetch;
  global.fetch = (async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    // The client-token still works; the embed page does not.
    if (url.hostname === 'clienttoken.spotify.com') {
      return json({ granted_token: { token: CLIENT_TOKEN, refresh_after_seconds: 1_209_600 } });
    }
    return new Response('nope', { status: 503 });
  }) as typeof fetch;
  try {
    await assert.rejects(() => webPathfinderSession.getTokens(), /unavailable/);
  } finally {
    global.fetch = original;
    resetWebTokenCache();
  }
});

/**
 * The point of the whole exercise: an account with no librespot session still reaches pathfinder.
 *
 * Asserted at the wire rather than on parsed content — what matters is that the scraped bearer
 * and minted client-token arrive at api-partner. Pinning Spotify's GraphQL response shape in a
 * mock would only test the fiction.
 */
test('editorial browsing reaches pathfinder with scraped tokens and no librespot', async () => {
  resetWebTokenCache();
  const original = global.fetch;
  const seen: Array<{ url: string; auth: string | null; clientToken: string | null }> = [];
  global.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());

    if (url.hostname === 'clienttoken.spotify.com') {
      return json({ granted_token: { token: CLIENT_TOKEN, refresh_after_seconds: 1_209_600 } });
    }
    if (url.hostname === 'open.spotify.com' && url.pathname.startsWith('/embed/')) {
      return new Response(embedPage(BEARER), { status: 200 });
    }
    // The persisted-query-hash scrape: the landing page names the bundle, the bundle carries
    // the operation→hash triples.
    if (url.hostname === 'open.spotify.com' && url.pathname === '/') {
      return new Response(
        '<script src="https://open.spotifycdn.com/cdn/build/web-player/web-player.deadbeef.js"></script>',
        { status: 200 },
      );
    }
    if (url.pathname.endsWith('web-player.deadbeef.js')) {
      return new Response(`x=["browsePage","query","${HASH}"]`, { status: 200 });
    }
    if (url.hostname === 'api-partner.spotify.com') {
      const headers = new Headers(init?.headers ?? {});
      seen.push({
        url: url.toString(),
        auth: headers.get('authorization'),
        clientToken: headers.get('client-token'),
      });
      return json({ data: { browse: { __typename: 'BrowseNode' } } });
    }
    return new Response(`unrouted ${url.toString()}`, { status: 404 });
  }) as typeof fetch;

  try {
    const provider = new SpotifyAccountProvider({
      providerId: 'spotify@rudy',
      // No `librespotCredentials`: the session that used to be the only token source cannot be
      // opened, which is exactly the state that emptied Genres & Moods.
      account: { id: 'rudy', user: 'rudy', country: 'NL', refreshToken: 'unused-in-test' },
      persistAccount: async () => null,
    });

    const folder = await provider.getFolder('genres', 0, 20);
    assert.ok(folder, 'the folder is served, not refused');

    assert.equal(seen.length, 1, 'one pathfinder call');
    assert.equal(seen[0]?.auth, `Bearer ${BEARER}`, 'the scraped bearer went out');
    assert.equal(seen[0]?.clientToken, CLIENT_TOKEN, 'with the minted client-token');
    assert.match(seen[0]?.url ?? '', /operationName=browsePage/);
    assert.match(seen[0]?.url ?? '', new RegExp(HASH));
  } finally {
    global.fetch = original;
    resetWebTokenCache();
  }
});
