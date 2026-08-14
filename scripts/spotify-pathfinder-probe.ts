/**
 * Can pathfinder run without librespot?
 *
 * The production pathfinder module needs exactly one thing from librespot: a session object
 * with `getTokens()`. Everything else — the HTTP, the persisted-query-hash scraping, the
 * parsing — is already TypeScript in this repo. So this probe mints the same two tokens the
 * web player mints, over plain HTTPS, wraps them in a stub session, and hands that stub to the
 * REAL production functions. What they return is what a librespot-free Spotify would browse.
 *
 * Two tokens are involved, and only the second one is about a person:
 *  - the client-token, from clienttoken.spotify.com — device-scoped, no account
 *  - the bearer, from open.spotify.com/api/token — anonymous, or the logged-in one when an
 *    `sp_dc` cookie is supplied (SP_DC=... in the environment)
 *
 * Run: npx ts-node --transpile-only -r tsconfig-paths/register scripts/spotify-pathfinder-probe.ts
 */
import {
  fetchBrowseCategories,
  fetchCategoryEntries,
  fetchArtistTopTracks,
  fetchPlaylistTracks,
  fetchAlbumTracks,
  search,
  setPathfinderLocale,
  BROWSE_ROOT_URI,
  type PathfinderSession,
} from '@/adapters/content/providers/spotify/spotifyPathfinder';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
/** The web player's own client id — what clienttoken.spotify.com expects to be told. */
const WEB_CLIENT_ID = 'd8a5ed958d274c2e8ee717e6a4b0971d';

async function mintClientToken(): Promise<string | null> {
  const res = await fetch('https://clienttoken.spotify.com/v1/clienttoken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      client_data: {
        client_version: '1.2.46.25',
        client_id: WEB_CLIENT_ID,
        js_sdk_data: {
          device_brand: 'unknown',
          device_model: 'unknown',
          os: 'linux',
          os_version: 'unknown',
        },
      },
    }),
  });
  const text = await res.text();
  console.log(`clienttoken             HTTP ${res.status}`);
  if (!res.ok) {
    console.log(`   ${text.slice(0, 200)}`);
    return null;
  }
  const token = JSON.parse(text)?.granted_token?.token ?? null;
  console.log(`   granted: ${token ? `${String(token).slice(0, 18)}… (${String(token).length} chars)` : 'NONE'}`);
  return token;
}

async function mintBearer(spDc?: string): Promise<{ accessToken: string; anonymous: boolean } | null> {
  const res = await fetch(
    'https://open.spotify.com/api/token?reason=transport&productType=web-player',
    {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        ...(spDc ? { Cookie: `sp_dc=${spDc}` } : {}),
      },
    },
  );
  const text = await res.text();
  console.log(`api/token ${spDc ? '(sp_dc)' : '(anon) '}        HTTP ${res.status}`);
  if (!res.ok) {
    console.log(`   ${text.slice(0, 300)}`);
    return null;
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    console.log(`   non-JSON body: ${text.slice(0, 200)}`);
    return null;
  }
  if (!json.accessToken) {
    console.log(`   no accessToken; keys=${Object.keys(json).join(',')} — ${text.slice(0, 200)}`);
    return null;
  }
  const ttl = Math.round((json.accessTokenExpirationTimestampMs - Date.now()) / 1000);
  console.log(
    `   accessToken ${String(json.accessToken).slice(0, 18)}…  anonymous=${json.isAnonymous}  ttl=${ttl}s`,
  );
  return { accessToken: json.accessToken, anonymous: Boolean(json.isAnonymous) };
}

/**
 * The bearer as the embed player gets it.
 *
 * `open.spotify.com/embed/<type>/<id>` is server-rendered and its `__NEXT_DATA__` carries a
 * session access token — Spotify hands this to any visitor, no account and no cookie. This is
 * the same shape of thing as Apple Music's scraped web-player token, and unlike
 * `/api/token` it is not gated.
 */
async function scrapeEmbedBearer(): Promise<{ accessToken: string; anonymous: boolean } | null> {
  const res = await fetch(
    'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M',
    { headers: { 'User-Agent': UA, 'Accept-Language': 'nl-NL' } },
  );
  console.log(`embed scrape            HTTP ${res.status}`);
  if (!res.ok) {
    return null;
  }
  const html = await res.text();
  const blob = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!blob?.[1]) {
    console.log('   no __NEXT_DATA__ in the embed page');
    return null;
  }
  const session = JSON.parse(blob[1])?.props?.pageProps?.state?.settings?.session;
  const accessToken = session?.accessToken;
  if (typeof accessToken !== 'string' || !accessToken) {
    console.log('   no accessToken in the embed session');
    return null;
  }
  const ttl = Math.round((Number(session.accessTokenExpirationTimestampMs) - Date.now()) / 1000);
  console.log(`   accessToken ${accessToken.slice(0, 18)}…  anonymous=${session.isAnonymous}  ttl=${ttl}s`);
  return { accessToken, anonymous: Boolean(session.isAnonymous) };
}

async function main(): Promise<void> {
  const spDc = process.env.SP_DC?.trim() || undefined;
  const [clientToken, apiToken] = await Promise.all([mintClientToken(), mintBearer(spDc)]);
  // The gated endpoint first (so its refusal stays visible), then the public embed page.
  const bearer = apiToken ?? (await scrapeEmbedBearer());
  if (!clientToken || !bearer) {
    console.log('\nCould not mint tokens over HTTPS — stopping here.');
    return;
  }

  // The stub that stands in for librespot, entirely.
  const session: PathfinderSession = {
    getTokens: async () => ({
      accessToken: bearer.accessToken,
      tokenType: 'Bearer',
      clientToken,
      expiresInMs: 3_600_000,
    }),
  };

  setPathfinderLocale('nl-NL');
  console.log('\n--- real production pathfinder calls, librespot-free ---');

  const cats = await fetchBrowseCategories(session);
  console.log(
    `fetchBrowseCategories   ${cats.length}: ${cats.map((c) => c.title).join(', ').slice(0, 170)}`,
  );

  if (cats[0]) {
    const entries = await fetchCategoryEntries(session, cats[0].uri);
    console.log(
      `fetchCategoryEntries    ${entries.length} in "${cats[0].title}": ${entries
        .slice(0, 4)
        .map((e) => `${e.kind}:${e.name}`)
        .join(' | ')
        .slice(0, 170)}`,
    );
  }

  const top = await fetchArtistTopTracks(session, 'spotify:artist:0Ty63ceoRnnJKVEYP0VQpk');
  console.log(
    `fetchArtistTopTracks    ${top?.length ?? 'null'}: ${(top ?? []).slice(0, 5).map((t) => t.name).join(' | ')}`,
  );

  const found = await search(session, 'bjork', 5);
  console.log(
    `search                  ${
      found
        ? Object.entries(found)
          .map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : '?'}`)
          .join(' ')
        : 'null'
    }`,
  );

  const browseRoot = await fetchCategoryEntries(session, BROWSE_ROOT_URI);
  console.log(`browse root             ${browseRoot.length} entries`);

  // What an anonymous token costs: the Music hub backs "Popular Playlists", and with a
  // logged-in (librespot) token it carries the account's own algorithmic playlists. This
  // reports whether they survive without one — the exact residual dependency.
  const popular = await fetchCategoryEntries(session, 'spotify:page:0JQ5DAqbMKFSi39LMRT0Cy');
  const names = popular.map((e) => e.name);
  console.log(`popular playlists       ${popular.length}: ${names.slice(0, 8).join(' | ').slice(0, 150)}`);
  for (const personal of ['Discover Weekly', 'Release Radar', 'Daily Mix', 'Made For']) {
    console.log(
      `   ${personal.padEnd(16)} ${names.some((n) => n.toLowerCase().includes(personal.toLowerCase())) ? 'PRESENT' : 'absent'}`,
    );
  }

  // The decisive pair for an anonymous token: opening an editorial playlist and an album.
  // Both are what the Web API answers 404 for, so if these are empty the browse tree can
  // list editorial content but not play any of it.
  const pl = await fetchPlaylistTracks(session, 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', 0, 5);
  console.log(
    `fetchPlaylistTracks     ${pl?.items?.length ?? 'null'}/${pl?.total ?? '?'}: ${(pl?.items ?? [])
      .slice(0, 3)
      .map((t) => `${t.name} — ${t.owner ?? ''}`)
      .join(' | ')
      .slice(0, 150)}`,
  );
  const al = await fetchAlbumTracks(session, 'spotify:album:1bqeVjo54gj4BjjOH8dC97', 0, 5);
  console.log(
    `fetchAlbumTracks        ${al?.items?.length ?? 'null'}/${al?.total ?? '?'}: ${(al?.items ?? [])
      .slice(0, 3)
      .map((t) => t.name)
      .join(' | ')
      .slice(0, 150)}`,
  );
}

void main();
