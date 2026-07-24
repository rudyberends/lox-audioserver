import { createLogger } from '@/shared/logging/logger';

const SC_HOME = 'https://soundcloud.com/';
const SC_API_BASE = 'https://api-v2.soundcloud.com';
const SC_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// SoundCloud has no public API registration since 2019, so we resolve the same
// public `client_id` the web player uses by scraping it from the site's JS
// bundles. It rotates every so often; we cache it and re-scrape whenever a call
// comes back 401 (see request()).
const CLIENT_ID_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const REQUEST_TIMEOUT_MS = 12_000;

export interface SoundCloudTranscoding {
  url: string;
  preset?: string;
  snipped?: boolean;
  format?: { protocol?: string; mime_type?: string };
}

export interface SoundCloudTrack {
  id: number;
  kind?: string;
  title?: string;
  duration?: number;
  full_duration?: number;
  permalink_url?: string;
  artwork_url?: string | null;
  streamable?: boolean;
  policy?: string;
  track_authorization?: string;
  genre?: string;
  user?: { id: number; username?: string; permalink?: string; avatar_url?: string | null };
  publisher_metadata?: { artist?: string; album_title?: string } | null;
  media?: { transcodings?: SoundCloudTranscoding[] };
}

export interface SoundCloudUser {
  id: number;
  kind?: string;
  username?: string;
  permalink?: string;
  permalink_url?: string;
  avatar_url?: string | null;
  description?: string;
}

export interface SoundCloudPlaylist {
  id: number;
  kind?: string;
  title?: string;
  permalink_url?: string;
  artwork_url?: string | null;
  calculated_artwork_url?: string | null;
  description?: string;
  track_count?: number;
  genre?: string;
  user?: { id: number; username?: string };
  tracks?: SoundCloudTrack[];
}

export interface SoundCloudCollection<T> {
  collection: T[];
  total_results?: number;
  next_href?: string | null;
}

interface SoundCloudClientOptions {
  /** Optional OAuth token (unlocks full tracks + the user's library). */
  oauthToken?: string;
  /** Optional pinned client_id (skips scraping when set). */
  clientId?: string;
}

/**
 * Thin client over SoundCloud's unofficial `api-v2` endpoint. Handles
 * `client_id` resolution/caching and injects the OAuth token (when configured)
 * so both catalog browsing and stream resolution share one auth surface.
 */
export class SoundCloudClient {
  private readonly log = createLogger('Content', 'SoundCloudClient');
  private readonly oauthToken?: string;
  private readonly pinnedClientId?: string;
  private cachedClientId: string | null = null;
  private cachedClientIdAt = 0;
  private clientIdInflight: Promise<string | null> | null = null;

  constructor(options: SoundCloudClientOptions = {}) {
    this.oauthToken = options.oauthToken?.trim() || undefined;
    this.pinnedClientId = options.clientId?.trim() || undefined;
    if (this.pinnedClientId) {
      this.cachedClientId = this.pinnedClientId;
      this.cachedClientIdAt = Number.MAX_SAFE_INTEGER;
    }
  }

  public hasOauthToken(): boolean {
    return Boolean(this.oauthToken);
  }

  /**
   * Resolve (and cache) the public web `client_id`. Re-scrapes when the cache
   * has expired or a caller forces a refresh after a 401.
   */
  public async getClientId(forceRefresh = false): Promise<string | null> {
    if (this.pinnedClientId) {
      return this.pinnedClientId;
    }
    const now = Date.now();
    if (!forceRefresh && this.cachedClientId && now - this.cachedClientIdAt < CLIENT_ID_TTL_MS) {
      return this.cachedClientId;
    }
    if (this.clientIdInflight) {
      return this.clientIdInflight;
    }
    this.clientIdInflight = this.scrapeClientId()
      .then((id) => {
        if (id) {
          this.cachedClientId = id;
          this.cachedClientIdAt = Date.now();
        }
        // Fall back to a stale-but-present id rather than nothing.
        return id ?? this.cachedClientId;
      })
      .finally(() => {
        this.clientIdInflight = null;
      });
    return this.clientIdInflight;
  }

  /**
   * GET an api-v2 path and parse JSON. `client_id` is appended automatically and
   * the OAuth token (when set) is sent as a bearer. A 401 triggers a single
   * client_id re-scrape and retry.
   */
  public async apiGet<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T | null> {
    const build = async (forceRefresh: boolean): Promise<Response | null> => {
      const clientId = await this.getClientId(forceRefresh);
      if (!clientId) {
        this.log.warn('soundcloud client_id unavailable');
        return null;
      }
      const url = new URL(path.startsWith('http') ? path : `${SC_API_BASE}${path}`);
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
      url.searchParams.set('client_id', clientId);
      return this.rawFetch(url.toString());
    };

    try {
      let res = await build(false);
      if (res && res.status === 401) {
        this.log.debug('soundcloud 401; refreshing client_id');
        res = await build(true);
      }
      if (!res || !res.ok) {
        if (res) {
          this.log.debug('soundcloud api request failed', { path, status: res.status });
        }
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      this.log.warn('soundcloud api request error', {
        path,
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Resolve a signed CDN URL for a track transcoding (progressive or HLS). The
   * transcoding `url` already points at api-v2; we append client_id (+ token)
   * and read back the `{ url }` payload.
   */
  public async resolveTranscodingUrl(transcodingUrl: string, trackAuthorization?: string): Promise<string | null> {
    const data = await this.apiGet<{ url?: string }>(transcodingUrl, {
      track_authorization: trackAuthorization,
    });
    return typeof data?.url === 'string' ? data.url : null;
  }

  private async rawFetch(url: string): Promise<Response> {
    const headers: Record<string, string> = {
      'User-Agent': SC_USER_AGENT,
      Accept: 'application/json',
    };
    if (this.oauthToken) {
      headers.Authorization = `OAuth ${this.oauthToken}`;
    }
    return fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  private async scrapeClientId(): Promise<string | null> {
    try {
      const homeRes = await fetch(SC_HOME, {
        headers: { 'User-Agent': SC_USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!homeRes.ok) {
        this.log.warn('soundcloud homepage fetch failed', { status: homeRes.status });
        return null;
      }
      const html = await homeRes.text();
      const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
        .map((m) => m[1])
        .filter((src): src is string => Boolean(src && /\.js(\?|$)/.test(src)));
      // The client_id lives in one of the later-loaded bundles; scan newest first.
      for (const src of scripts.reverse()) {
        const jsUrl = src.startsWith('http') ? src : `${SC_HOME.replace(/\/$/, '')}${src}`;
        const clientId = await this.extractClientIdFromScript(jsUrl);
        if (clientId) {
          this.log.info('soundcloud client_id resolved');
          return clientId;
        }
      }
      this.log.warn('soundcloud client_id not found in web bundles');
      return null;
    } catch (err) {
      this.log.warn('soundcloud client_id scrape failed', {
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async extractClientIdFromScript(jsUrl: string): Promise<string | null> {
    try {
      const res = await fetch(jsUrl, {
        headers: { 'User-Agent': SC_USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        return null;
      }
      const js = await res.text();
      const match = js.match(/client_id[:=]"([a-zA-Z0-9]{20,})"/) || js.match(/[?&]client_id=([a-zA-Z0-9]{20,})/);
      return match?.[1] ?? null;
    } catch {
      return null;
    }
  }
}
