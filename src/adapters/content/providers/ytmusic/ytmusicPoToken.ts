import { createLogger } from '@/shared/logging/logger';

const log = createLogger('Content', 'YTMusicPoToken');

/**
 * Where the PO Token server lives, and whether it is answering.
 *
 * YouTube's `web_music` client only hands out format urls against a "proof of
 * origin" token, which has to be minted by a BotGuard runner rather than by
 * yt-dlp. That runner is a small HTTP service the user runs next to us (the
 * bgutil PO Token provider, the same one Music Assistant asks for), so all we
 * own here is its address and the question of whether it is up.
 *
 * The default is the provider's own default port, so someone already running it
 * for another app needs to configure nothing.
 */
export const DEFAULT_PO_TOKEN_SERVER_URL = 'http://127.0.0.1:4416';

export type PotServerPing = {
  ok: boolean;
  /** Version the server reports, when it answered with one. */
  version: string | null;
  /** Why the ping failed, for the setup screen to show verbatim. */
  error: string | null;
};

type CacheEntry = { ping: PotServerPing; expiresAt: number };

const pingCache = new Map<string, CacheEntry>();

/**
 * A reachable server is re-checked lazily; an unreachable one is re-checked sooner
 * but still not per track — a resolve must not pay a connect timeout every time
 * someone leaves a stale url configured.
 */
const OK_TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 30_000;

export function normalizePotServerUrl(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return '';
  // Tolerate a trailing slash so `/ping` never becomes `//ping`.
  return value.replace(/\/+$/, '');
}

export async function pingPotServer(rawUrl: string, options?: { force?: boolean }): Promise<PotServerPing> {
  const url = normalizePotServerUrl(rawUrl);
  if (!url) {
    return { ok: false, version: null, error: 'no PO Token server configured' };
  }
  if (options?.force !== true) {
    const cached = pingCache.get(url);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.ping;
    }
  }

  const ping = await requestPing(url);
  pingCache.set(url, { ping, expiresAt: Date.now() + (ping.ok ? OK_TTL_MS : FAIL_TTL_MS) });
  return ping;
}

async function requestPing(url: string): Promise<PotServerPing> {
  try {
    const res = await fetch(`${url}/ping`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) {
      return { ok: false, version: null, error: `PO Token server answered HTTP ${res.status}` };
    }
    // The server reports `{ server_uptime, version }`; a version is nice to show but
    // its absence is not a failure — answering /ping at all is the contract.
    let version: string | null = null;
    try {
      const body = (await res.json()) as { version?: unknown };
      version = typeof body?.version === 'string' ? body.version : null;
    } catch {
      /* ignore */
    }
    return { ok: true, version, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug('PO Token server ping failed', { url, message });
    return { ok: false, version: null, error: message };
  }
}

/**
 * The extractor args that put the token into the extraction.
 *
 * `player_client=web_music` is the client the token unlocks, and the skips are the
 * scraping it does not need for an audio-only resolve.
 */
export function potExtractorArgs(rawUrl: string): string[] {
  const url = normalizePotServerUrl(rawUrl);
  if (!url) return [];
  return [
    '--extractor-args',
    `youtubepot-bgutilhttp:base_url=${url}`,
    '--extractor-args',
    'youtube:player_client=web_music;skip=translated_subs,dash',
  ];
}
