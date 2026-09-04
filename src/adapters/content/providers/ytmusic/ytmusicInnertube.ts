import crypto from 'node:crypto';

const YTM_API_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
const YTM_ORIGIN = 'https://music.youtube.com';

export type YtMusicInnertubeClientOptions = {
  cookie: string;
  hl?: string;
  gl?: string;
  clientName?: string;
  clientVersion?: string;
  userAgent?: string;
};

export class YtMusicInnertubeError extends Error {
  public readonly status: number | null;
  public readonly bodySnippet: string | null;
  constructor(message: string, opts: { status?: number | null; bodySnippet?: string | null } = {}) {
    super(message);
    this.status = opts.status ?? null;
    this.bodySnippet = opts.bodySnippet ?? null;
  }
}

/**
 * The cookie no longer identifies anyone.
 *
 * Its own error type because an expired cookie is the one YouTube Music failure a
 * user has to act on, and it is also the one that hides best: see
 * `isSignedOutResponse` for why nothing else in the response gives it away.
 */
export class YtMusicCookieExpiredError extends Error {
  constructor(message = 'ytmusic cookie is no longer signed in') {
    super(message);
  }
}

/**
 * Whether a browse response came back signed out.
 *
 * A dead cookie does not fail: YouTube answers **200** with a well-formed body that
 * simply has a "Sign in" prompt where the library should be. Measured against an
 * expired cookie, a liked-albums browse returned 200 with a `signInEndpoint` and
 * zero items — indistinguishable, to every check we had, from an empty library. So
 * that prompt is the signal, and the whole reason this exists.
 *
 * `loggedOut === false` can only veto: the prompt is the part actually observed, and
 * a response that positively states it is signed in should never be called expired.
 */
export function isSignedOutResponse(json: unknown): boolean {
  const loggedOut = (json as { responseContext?: { mainAppWebResponseContext?: { loggedOut?: unknown } } })
    ?.responseContext?.mainAppWebResponseContext?.loggedOut;
  if (loggedOut === false) return false;
  return hasKeyDeep(json, 'signInEndpoint');
}

function hasKeyDeep(value: unknown, key: string, depth = 0): boolean {
  // Innertube payloads nest deeply but not unboundedly; the cap keeps a hostile or
  // cyclic body from turning a health check into a hang.
  if (depth > 30 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((entry) => hasKeyDeep(entry, key, depth + 1));
  }
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, key)) return true;
  for (const nested of Object.values(record)) {
    if (hasKeyDeep(nested, key, depth + 1)) return true;
  }
  return false;
}

export function getCookieValue(cookieHeader: string, name: string): string | null {
  const raw = String(cookieHeader || '');
  if (!raw) return null;
  const parts = raw.split(';');
  for (const p of parts) {
    const [k, ...rest] = p.trim().split('=');
    if (!k) continue;
    if (k.trim() !== name) continue;
    return rest.join('=');
  }
  return null;
}

export function buildSapisidHashAuthorization(cookieHeader: string, origin = YTM_ORIGIN): string | null {
  const cookie = String(cookieHeader || '');
  const sapisid = getCookieValue(cookie, '__Secure-3PAPISID') ?? getCookieValue(cookie, 'SAPISID');
  if (!sapisid) return null;
  const ts = String(Math.floor(Date.now() / 1000));
  const sha1 = crypto.createHash('sha1').update(`${ts} ${sapisid} ${origin}`, 'utf8').digest('hex');
  return `SAPISIDHASH ${ts}_${sha1}`;
}

/**
 * A pointer to the next page of a browse result.
 *
 * YouTube Music serves a library section 25 items at a time and hands back a token
 * for the rest. It is mid-migration between two dialects for spending that token, and
 * `style` says which one this token came from: `query` puts it in the URL and keeps
 * the original `browseId` in the body, `body` replaces the body with the token alone.
 * Measured against a live account, the library sections still answer in the `query`
 * dialect; `body` is carried because that is the one they are moving to, and a token
 * sent in the wrong envelope is ignored rather than refused.
 */
export type YtMusicContinuation = {
  token: string;
  style: 'query' | 'body';
};

export async function ytmBrowse(
  browseId: string,
  options: YtMusicInnertubeClientOptions,
  continuation?: YtMusicContinuation | null,
): Promise<any> {
  const cookie = String(options.cookie || '').trim();
  if (!cookie) {
    throw new YtMusicInnertubeError('ytmusic innertube browse requires cookie');
  }
  const authorization = buildSapisidHashAuthorization(cookie);
  if (!authorization) {
    throw new YtMusicInnertubeError('ytmusic cookie missing __Secure-3PAPISID/SAPISID');
  }

  let endpoint = `https://music.youtube.com/youtubei/v1/browse?alt=json&key=${encodeURIComponent(YTM_API_KEY)}`;
  if (continuation?.style === 'query') {
    // Both spellings, because both are what the web client puts on the wire.
    const token = encodeURIComponent(continuation.token);
    endpoint += `&ctoken=${token}&continuation=${token}`;
  }
  const body = {
    // The newer dialect addresses a page by token alone; the older one repeats the
    // browseId and carries its token in the query string instead.
    ...(continuation?.style === 'body' ? { continuation: continuation.token } : { browseId }),
    context: {
      client: {
        clientName: options.clientName ?? 'WEB_REMIX',
        clientVersion: options.clientVersion ?? '1.20260208.01.00',
        ...(options.hl ? { hl: options.hl } : {}),
        ...(options.gl ? { gl: options.gl } : {}),
      },
      user: {},
    },
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: YTM_ORIGIN,
      'user-agent':
        options.userAgent ??
        'Mozilla/5.0 (X11; Linux) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      cookie,
      authorization,
      accept: '*/*',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new YtMusicInnertubeError('ytmusic innertube browse failed', {
      status: res.status,
      bodySnippet: text.slice(0, 4000),
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new YtMusicInnertubeError('ytmusic innertube browse returned non-json', {
      status: res.status,
      bodySnippet: text.slice(0, 4000),
    });
  }
  if (isSignedOutResponse(parsed)) {
    throw new YtMusicCookieExpiredError();
  }
  return parsed;
}

