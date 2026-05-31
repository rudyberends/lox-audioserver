/**
 * Shared Apple Music web-auth helpers.
 *
 * Both the metadata provider and the stream service talk to Apple's web endpoints with the same
 * browser-like headers and obtain a MusicKit developer (bearer) token the same way: by scraping
 * it out of the Apple Music web player's JS bundle. That scrape is inherently fragile — Apple can
 * rename the bundle at any time — so it lives here, in one place, instead of being duplicated.
 *
 * Token caching stays with each caller because the scoping differs (the provider caches per
 * account instance; the stream service caches per bridge).
 */

const APPLE_MUSIC_WEB_BASE = 'https://music.apple.com';
const SCRAPE_TIMEOUT_MS = 15_000;

/**
 * The MusicKit developer token (ES256 JWT) lives in config (`content.appleMusic.developerToken`),
 * mirroring Music Assistant's MUSIC_APP_TOKEN. Unlike the scraped web-player token it is not
 * origin-locked, so MusicKit `authorize()` works from any origin (incl. plain http on a LAN), and
 * it doubles as the Apple Music API bearer. It expires (~6 months) — regenerate before `exp`.
 *
 * Bootstrap registers a source so this module reads the live config value without a config import.
 */
type DeveloperTokenSource = () => string | null | undefined;
let developerTokenSource: DeveloperTokenSource | null = null;

export function setAppleMusicDeveloperTokenSource(source: DeveloperTokenSource | null): void {
  developerTokenSource = source;
}

function rawConfiguredToken(): string | null {
  const value = developerTokenSource?.();
  return value && value.trim() ? value.trim() : null;
}

/** Raw configured developer token (may be expired) — for the sign-in page, which reports expiry. */
export function getConfiguredDeveloperToken(): string | null {
  return rawConfiguredToken();
}

/** Configured developer token only if still valid (unexpired) — for the API bearer / fallbacks. */
export function getShippedDeveloperToken(): string | null {
  const token = rawConfiguredToken();
  return token && isJwtUnexpired(token) ? token : null;
}

/** True when a JWT's `exp` is absent or still in the future (i.e. the token is usable). */
function isJwtUnexpired(token: string): boolean {
  try {
    const parts = token.split('.');
    const payloadPart = parts[1];
    if (parts.length !== 3 || !payloadPart) return false;
    const normalized = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(normalized, 'base64').toString('utf-8')) as { exp?: number };
    if (typeof payload.exp !== 'number') return true;
    return payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

/** Browser-like base headers Apple's web endpoints expect; adds user-token headers when present. */
export function buildBaseHeaders(userToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:95.0) Gecko/20100101 Firefox/95.0',
    Accept: 'application/json',
    'Accept-Language': 'en-US',
    // Allow response compression; the previous value ('utf-8') is not a valid encoding token.
    'Accept-Encoding': 'gzip, deflate, br',
    'content-type': 'application/json',
    'x-apple-renewal': 'true',
    DNT: '1',
    Connection: 'keep-alive',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    origin: 'https://music.apple.com',
    referer: 'https://music.apple.com/',
  };
  if (userToken) {
    headers['Media-User-Token'] = userToken;
    headers['Music-User-Token'] = userToken;
  }
  return headers;
}

/**
 * Scrape a MusicKit developer (bearer) token from the Apple Music web player bundle.
 *
 * Returns the token string, or null if the JS bundle or the embedded token can't be located
 * (most likely because Apple changed the bundle layout — update the patterns here when that
 * happens). Network/timeout errors are surfaced as null too.
 */
export async function scrapeBearerToken(headers: Record<string, string>): Promise<string | null> {
  const homeRes = await fetch(APPLE_MUSIC_WEB_BASE, {
    headers,
    signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
  });
  const homeText = await homeRes.text();
  const match = homeText.match(/\/(assets\/index-legacy[~-][^/"]+\.js)/i);
  if (!match) return null;

  const jsRes = await fetch(`${APPLE_MUSIC_WEB_BASE}/${match[1]}`, {
    headers,
    signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
  });
  const jsText = await jsRes.text();
  const tokenMatch = jsText.match(/eyJh[^"]+/);
  return tokenMatch ? tokenMatch[0] : null;
}
