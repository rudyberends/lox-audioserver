import type { IncomingMessage } from 'node:http';
import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import { hasUsers, verifyUser } from '@/application/auth/localUsers';

/**
 * How long a verified credential stays good.
 *
 * WebDAV is sessionless like Subsonic: every request re-sends the Authorization
 * header, and a Finder folder listing is many requests. Verification hashes a
 * password, so without this cache a directory walk would re-hash on every entry.
 */
const POSITIVE_TTL_MS = 5 * 60 * 1000;

/** Failures cached briefly, so a client looping with a stale password is cheap. */
const NEGATIVE_TTL_MS = 30 * 1000;

/** Bound on the cache so an unauthenticated caller cannot grow it without limit. */
const MAX_CACHE_ENTRIES = 256;

type CacheEntry = { expiresAt: number; username: string | null };

/**
 * HTTP Basic auth for the WebDAV share.
 *
 * Basic — not the admin session cookie — because the clients are macOS Finder and
 * Windows Explorer, which have no way to obtain a cookie. Credentials are the same
 * local accounts the admin UI uses, so there is no second user list to manage.
 *
 * Basic sends the password reasonably reversibly (base64), so over plain HTTP this
 * is only as private as the LAN it runs on. That matches the rest of the server's
 * exposure model, but it is a deliberate choice rather than an oversight.
 */
export class WebdavAuthenticator {
  private readonly log = createLogger('WebDAV', 'Auth');
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly configPort: ConfigPort) {}

  /** True when no local account exists yet, so the share cannot be opened at all. */
  public get unconfigured(): boolean {
    return !hasUsers(this.configPort);
  }

  /**
   * Resolves the username for a request, or null when the credentials are missing
   * or wrong. Callers answer null with {@link challenge}.
   */
  public authenticate(req: IncomingMessage): string | null {
    const header = req.headers.authorization ?? '';
    const match = /^Basic\s+(.+)$/i.exec(header.trim());
    if (!match?.[1]) {
      return null;
    }

    let decoded: string;
    try {
      decoded = Buffer.from(match[1], 'base64').toString('utf8');
    } catch {
      return null;
    }

    // Password may itself contain ':', so split only on the first one.
    const separator = decoded.indexOf(':');
    if (separator < 0) {
      return null;
    }
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    if (!username) {
      return null;
    }

    const now = Date.now();
    // NUL separator: it cannot occur in a username, so no pair of different
    // credentials can collide into one cache key.
    const cacheKey = `${username}\u0000${password}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.username;
    }

    const user = verifyUser(this.configPort, username, password);
    const resolved = user ? user.username : null;
    if (!resolved) {
      this.log.debug('webdav auth rejected', { username });
    }

    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      this.cache.clear();
    }
    this.cache.set(cacheKey, {
      username: resolved,
      expiresAt: now + (resolved ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
    });
    return resolved;
  }

  /** Header set that makes a client prompt for credentials. */
  public challenge(): Record<string, string> {
    return {
      'WWW-Authenticate': 'Basic realm="Music library", charset="UTF-8"',
      'Content-Length': '0',
    };
  }
}
