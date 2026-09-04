/**
 * Pathfinder tokens, scraped from the public web player.
 *
 * The pathfinder module needs exactly two credentials, and both used to come from a librespot
 * session — which means the whole editorial half of the Spotify tree (Popular Playlists, Genres
 * & Moods and everything under it, and the tracks of any Spotify-owned playlist) went blank
 * whenever that session could not be opened. None of it has a Web API equivalent: the browse
 * routes behind it answer 404.
 *
 * Both credentials are, however, handed to any visitor of the web player:
 *
 *  - the **client-token** from `clienttoken.spotify.com`, which is device-scoped and involves no
 *    account at all. Long-lived: it comes back with `refresh_after_seconds` around a fortnight.
 *  - the **bearer** from an `open.spotify.com/embed/...` page, which is server-rendered and
 *    carries a session access token in its `__NEXT_DATA__`. Roughly three hours.
 *
 * Deliberately NOT `open.spotify.com/api/token`: that endpoint refuses callers outside the web
 * player ("Usage of this endpoint is not permitted…"), and getting past it would mean
 * replicating an anti-abuse handshake. The embed page needs no such thing — it is just a public
 * page, the same way Apple Music's web-player token is scraped from a page it serves to
 * everyone.
 *
 * What this cannot do is be *someone*: the bearer is anonymous, so editorial content arrives
 * but the account's own algorithmic shelves (Discover Weekly, Release Radar, Daily Mix, Made For
 * You) do not — measured absent. Those still need a logged-in token, which is why the provider
 * used librespot's when it had one and treated this as the floor rather than the ceiling.
 */
import { createLogger } from '@/shared/logging/logger';
import type { SessionTokens } from '@/adapters/content/providers/spotify/spotifyPathfinder';

const log = createLogger('Content', 'SpotifyWebTokens');

const WEB_PLAYER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HTTP_TIMEOUT_MS = 10_000;

const CLIENT_TOKEN_URL = 'https://clienttoken.spotify.com/v1/clienttoken';
/** The web player's own client id — what `clienttoken` expects to be told it is talking to. */
const WEB_CLIENT_ID = 'd8a5ed958d274c2e8ee717e6a4b0971d';
const WEB_CLIENT_VERSION = '1.2.46.25';

/**
 * Embed pages to read the bearer from, tried in order.
 *
 * The token is anonymous and has nothing to do with the entity, so any public page serves —
 * these are simply Spotify-owned playlists, about as long-lived as an id gets. More than one so
 * that a retired playlist costs a fallback rather than the whole editorial tree.
 */
const EMBED_URLS = [
  'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M',
  'https://open.spotify.com/embed/playlist/37i9dQZEVXbMDoHDwVN2tF',
];

/** Refresh a token this long before it actually lapses, so a browse never races the expiry. */
const EXPIRY_MARGIN_MS = 60_000;

type Cached = { value: string; expiresAt: number };

let clientToken: Cached | null = null;
let clientTokenInflight: Promise<string | null> | null = null;
let bearer: Cached | null = null;
let bearerInflight: Promise<string | null> | null = null;

function fresh(cached: Cached | null): string | null {
  return cached && Date.now() < cached.expiresAt ? cached.value : null;
}

async function fetchClientToken(): Promise<string | null> {
  try {
    const res = await fetch(CLIENT_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': WEB_PLAYER_UA,
      },
      body: JSON.stringify({
        client_data: {
          client_version: WEB_CLIENT_VERSION,
          client_id: WEB_CLIENT_ID,
          js_sdk_data: {
            device_brand: 'unknown',
            device_model: 'unknown',
            os: 'linux',
            os_version: 'unknown',
          },
        },
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn('client-token request failed', { status: res.status });
      return null;
    }
    const payload = (await res.json()) as {
      granted_token?: { token?: unknown; refresh_after_seconds?: unknown };
    };
    const granted = payload?.granted_token;
    const token = typeof granted?.token === 'string' ? granted.token : '';
    if (!token) {
      log.warn('client-token response carried no token');
      return null;
    }
    // Spotify says when to come back; fall back to an hour if it ever stops saying.
    const refreshAfterSec = Number(granted?.refresh_after_seconds);
    const ttlMs = Number.isFinite(refreshAfterSec) && refreshAfterSec > 0
      ? refreshAfterSec * 1000
      : 3_600_000;
    clientToken = { value: token, expiresAt: Date.now() + Math.max(30_000, ttlMs - EXPIRY_MARGIN_MS) };
    return token;
  } catch (error) {
    log.warn('client-token request threw', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Pull the session access token out of one embed page's `__NEXT_DATA__`. */
async function scrapeBearerFrom(url: string): Promise<Cached | null> {
  const res = await fetch(url, {
    headers: { 'User-Agent': WEB_PLAYER_UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    log.debug('embed page not available', { url, status: res.status });
    return null;
  }
  const html = await res.text();
  const blob = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!blob?.[1]) {
    log.debug('embed page carried no __NEXT_DATA__', { url });
    return null;
  }
  let session: { accessToken?: unknown; accessTokenExpirationTimestampMs?: unknown } | undefined;
  try {
    session = JSON.parse(blob[1])?.props?.pageProps?.state?.settings?.session;
  } catch (error) {
    log.debug('embed __NEXT_DATA__ did not parse', {
      url,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  const token = typeof session?.accessToken === 'string' ? session.accessToken : '';
  if (!token) {
    log.debug('embed session carried no accessToken', { url });
    return null;
  }
  // The page states the expiry; without it, assume the short end of what Spotify hands out.
  const statedExpiry = Number(session?.accessTokenExpirationTimestampMs);
  const expiresAt = Number.isFinite(statedExpiry) && statedExpiry > Date.now()
    ? statedExpiry - EXPIRY_MARGIN_MS
    : Date.now() + 30 * 60_000;
  return { value: token, expiresAt };
}

async function fetchBearer(): Promise<string | null> {
  for (const url of EMBED_URLS) {
    try {
      const scraped = await scrapeBearerFrom(url);
      if (scraped) {
        bearer = scraped;
        return scraped.value;
      }
    } catch (error) {
      log.debug('embed scrape threw', {
        url,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  log.warn('no embed page yielded an access token', { tried: EMBED_URLS.length });
  return null;
}

/**
 * Both credentials, cached until they lapse.
 *
 * The in-flight promises matter: a single root browse fans out into several pathfinder calls at
 * once, and without them a cold cache would mint the same pair three or four times over.
 */
async function mint(): Promise<SessionTokens> {
  const [clientTokenValue, bearerValue] = await Promise.all([
    fresh(clientToken) ??
      (clientTokenInflight ??= fetchClientToken().finally(() => {
        clientTokenInflight = null;
      })),
    fresh(bearer) ??
      (bearerInflight ??= fetchBearer().finally(() => {
        bearerInflight = null;
      })),
  ]);
  if (!clientTokenValue || !bearerValue) {
    // Throwing rather than returning null: this is the shape `PathfinderSession` promises, and
    // the pathfinder query layer already treats a throwing `getTokens` as "no tokens".
    throw new Error('spotify web tokens unavailable');
  }
  return {
    accessToken: bearerValue,
    tokenType: 'Bearer',
    clientToken: clientTokenValue,
    // Pathfinder keeps its own short-lived cache on top of ours; the real expiry is enforced
    // here, by `fresh`.
    expiresInMs: Math.max(30_000, (bearer?.expiresAt ?? 0) - Date.now()),
  };
}

/**
 * The token source, as a `PathfinderSession`.
 *
 * A module-level singleton on purpose: the pathfinder layer caches tokens in a `WeakMap` keyed
 * on the session object, so handing out a fresh object per call would defeat that cache and
 * re-mint on every query.
 */
export const webPathfinderSession = {
  getTokens: mint,
};

/** Drop the cached tokens. For tests, and for a deliberate re-mint after a Spotify change. */
export function resetWebTokenCache(): void {
  clientToken = null;
  bearer = null;
  clientTokenInflight = null;
  bearerInflight = null;
}
