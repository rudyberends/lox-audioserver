import https from 'node:https';

/**
 * An upstream call that came back with something other than 200, or could not be
 * made at all.
 *
 * `status` is 0 when the request never got an answer (DNS, connect, timeout). The
 * distinction matters to callers: a 404 means "this endpoint has nothing", which is
 * worth following up with another endpoint, while a 403 or a timeout means "we could
 * not ask", where trying two more URLs only burns what little budget is left.
 */
export class UpstreamHttpError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    /** When the upstream says the quota returns, as epoch ms. Null if it did not say. */
    public readonly rateLimitResetAtMs: number | null,
  ) {
    super(message);
    this.name = 'UpstreamHttpError';
  }

  /**
   * True when the answer says "not now" rather than "not here": the quota is spent,
   * the token is bad, or nothing answered at all. Retrying a sibling endpoint on the
   * same host cannot help, and hammering makes an exhausted quota last longer.
   */
  public get isRefusal(): boolean {
    return this.status === 0 || this.status === 401 || this.status === 403 || this.status === 429;
  }
}

/**
 * GitHub allows 60 API requests an hour per IP unauthenticated, which one LAN with a
 * few admin tabs open can spend without trying. Any token lifts the same calls to
 * 5000/h, so honour one if the deployment provides it. Only sent to GitHub — a
 * credential must not leak to the npm registry or to a redirect target elsewhere.
 */
function authHeaders(url: string): Record<string, string> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return {};
  }
  if (host !== 'api.github.com') return {};
  const token = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** `x-ratelimit-reset` is epoch seconds, and only meaningful once the budget is gone. */
function parseRateLimitReset(headers: Record<string, string | string[] | undefined>): number | null {
  const raw = headers['x-ratelimit-reset'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const seconds = Number.parseInt(value ?? '', 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/**
 * Fetches and parses JSON over HTTPS, following redirects.
 *
 * Rejects with an {@link UpstreamHttpError} so callers can tell a missing resource
 * from a refused one.
 */
export async function fetchUpstreamJson(url: string, redirects = 0): Promise<unknown> {
  if (redirects > 5) {
    throw new UpstreamHttpError(`Too many redirects while fetching ${url}`, 0, null);
  }
  return new Promise((resolveOuter, rejectOuter) => {
    const request = https.get(
      url,
      {
        headers: {
          'User-Agent': 'sonn-core-bundle-fetch',
          Accept: 'application/vnd.github+json',
          ...authHeaders(url),
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.resume();
          resolveOuter(fetchUpstreamJson(response.headers.location, redirects + 1));
          return;
        }
        if (status !== 200) {
          response.resume();
          rejectOuter(
            new UpstreamHttpError(
              `Upstream request failed (${status}) for ${url}`,
              status,
              parseRateLimitReset(response.headers),
            ),
          );
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            resolveOuter(JSON.parse(body));
          } catch (err) {
            rejectOuter(err instanceof Error ? err : new Error(String(err)));
          }
        });
      },
    );
    request.on('error', (err) => rejectOuter(new UpstreamHttpError(err.message, 0, null)));
    request.setTimeout(4000, () =>
      request.destroy(new UpstreamHttpError(`Request timed out for ${url}`, 0, null)),
    );
  });
}
