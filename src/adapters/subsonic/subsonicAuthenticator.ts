import { createHash } from 'node:crypto';
import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { AudioServerConfig } from '@/domain/config/types';
import {
  MiniserverAuthClient,
  readMiniserverBaseUrlFromConfig,
} from '@/adapters/http/adminApi/auth/miniserverAuthClient';
import { MiniserverAuthError } from '@/adapters/http/adminApi/auth/types';
import { SubsonicError, SubsonicErrorCode } from '@/adapters/subsonic/subsonicResponse';
import {
  constantTimeEquals,
  hasUsers,
  rememberLoxoneUser,
  storedPassword,
  verifyUser,
} from '@/application/auth/localUsers';

/**
 * How long a verified Miniserver credential stays good.
 *
 * Subsonic is sessionless: every single request carries credentials, and a
 * client's library scan is hundreds of requests. Each Miniserver verification
 * costs three round-trips, so without this cache one scan would turn into a
 * sustained hammering of the Miniserver.
 */
const POSITIVE_TTL_MS = 5 * 60 * 1000;

/**
 * Failures are cached too, briefly. A client configured with a stale password
 * retries on every request; without this each retry would cost three more
 * Miniserver calls.
 */
const NEGATIVE_TTL_MS = 30 * 1000;

/** Bound on the cache, so a hostile caller cannot grow it without limit. */
const MAX_CACHE_ENTRIES = 256;

export type SubsonicCredentials =
  | { kind: 'password'; username: string; password: string }
  | { kind: 'token'; username: string; token: string; salt: string };

/** Which mechanisms can currently verify a Subsonic login. */
export type AuthAvailability = {
  /** Local username+password are configured. */
  local: boolean;
  /** Miniserver verification is possible (integrated mode, paired, reachable config). */
  loxone: boolean;
  /** Why Loxone auth is unavailable, for the admin UI to explain. */
  loxoneUnavailableReason: 'standalone' | 'not-paired' | 'no-miniserver' | null;
};

/**
 * Resolves who is allowed to use the Subsonic API.
 *
 * Two credential sources, and which apply depends on the deployment mode:
 *
 *   - **Loxone-integrated** — Miniserver accounts are the primary identity, so
 *     household members log in with the account they already have. Local
 *     credentials are an *optional* extra, not a requirement.
 *   - **Standalone** — there is no Miniserver, so local credentials are the only
 *     option and are mandatory.
 *
 * Any Miniserver user is accepted, not just admins: this gates content, and
 * requiring admin rights would mean one account for the whole household.
 *
 * The catch is Subsonic's salted-token form (`t`+`s`), which hands us only
 * `md5(password + salt)`. The Miniserver's own scheme also needs the plaintext
 * to build its auth hash, so a token login can never be delegated — it is
 * answerable only from local credentials. That is exactly the situation Subsonic
 * error 41 exists for, so token logins that can only be served by the Miniserver
 * get that code with an actionable message.
 */
export class SubsonicAuthenticator {
  private readonly log = createLogger('Subsonic', 'Auth');
  private readonly cache = new Map<string, { ok: boolean; expiresAt: number }>();

  constructor(
    private readonly config: ConfigPort,
    private readonly miniserver = new MiniserverAuthClient(),
  ) {}

  /** Which mechanisms are usable right now, for validation and the admin UI. */
  public availability(): AuthAvailability {
    const cfg = this.config.getConfig();
    const reason = this.loxoneUnavailableReason(cfg);
    return {
      local: hasUsers(this.config),
      loxone: reason === null,
      loxoneUnavailableReason: reason,
    };
  }

  private loxoneUnavailableReason(
    cfg: AudioServerConfig,
  ): AuthAvailability['loxoneUnavailableReason'] {
    const audioserver = cfg.system?.audioserver;
    if (audioserver?.mode === 'standalone') {
      return 'standalone';
    }
    if (!audioserver?.paired) {
      // Not paired yet: the Miniserver cannot vouch for anyone.
      return 'not-paired';
    }
    if (!readMiniserverBaseUrlFromConfig(cfg)) {
      return 'no-miniserver';
    }
    return null;
  }

  /**
   * Verify a request's credentials, throwing a {@link SubsonicError} that maps
   * onto the protocol's own fault codes when they do not check out.
   */
  public async authenticate(params: URLSearchParams): Promise<void> {
    const availability = this.availability();
    if (!availability.local && !availability.loxone) {
      throw new SubsonicError(
        SubsonicErrorCode.NotAuthorized,
        'Subsonic API has no usable credentials configured',
      );
    }

    const credentials = readCredentials(params);
    const client = params.get('c') ?? 'unknown';

    // Local first: it is free, and it is the only path that can answer a token
    // login. A local mismatch still falls through to the Miniserver, because a
    // Loxone account may legitimately share the username.
    if (availability.local && this.matchesLocal(credentials)) {
      this.log.debug('login accepted', { username: credentials.username, via: 'local', client });
      return;
    }

    if (!availability.loxone) {
      this.reject(credentials, client, 'local-mismatch');
      throw new SubsonicError(SubsonicErrorCode.WrongCredentials, 'Wrong username or password');
    }

    if (credentials.kind === 'token') {
      // Nothing to delegate: we hold a digest, and the Miniserver needs the
      // plaintext. Code 41 is the protocol's own way of saying this.
      this.reject(credentials, client, 'token-not-delegatable');
      throw new SubsonicError(
        SubsonicErrorCode.TokenAuthNotSupported,
        'Token authentication cannot be verified against the Miniserver. ' +
          'Enable plaintext (legacy) authentication in your client, or configure a local Subsonic password.',
      );
    }

    const ok = await this.verifyWithMiniserver(credentials.username, credentials.password);
    if (!ok) {
      this.reject(credentials, client, 'miniserver-rejected');
      throw new SubsonicError(SubsonicErrorCode.WrongCredentials, 'Wrong username or password');
    }
    this.log.debug('login accepted', { username: credentials.username, via: 'miniserver', client });

    // A verified plaintext login is the only chance to capture this password.
    // Recording it lets the same account work from a salted-token client next
    // time, without another plaintext round.
    void this.rememberVerifiedAccount(credentials.username, credentials.password);
  }

  /**
   * Record a rejected login. Logged at info because this is the one thing an
   * operator needs when "the app will not connect": which account, which
   * credential form the client chose, and why it was refused. Never logs the
   * credential itself.
   */
  private reject(
    credentials: SubsonicCredentials,
    client: string,
    reason: 'local-mismatch' | 'token-not-delegatable' | 'miniserver-rejected',
  ): void {
    this.log.info('login rejected', {
      username: credentials.username,
      form: credentials.kind === 'token' ? 'salted-token' : 'password',
      client,
      reason,
    });
  }

  private matchesLocal(credentials: SubsonicCredentials): boolean {
    if (credentials.kind === 'password') {
      return verifyUser(this.config, credentials.username, credentials.password) !== null;
    }
    // Salted token: recompute the digest over the stored password. This is the
    // only credential form that cannot be delegated to the Miniserver, so a
    // server-local account is what makes it work at all.
    const password = storedPassword(this.config, credentials.username);
    if (!password) {
      return false;
    }
    const expected = createHash('md5').update(`${password}${credentials.salt}`).digest('hex');
    return constantTimeEquals(credentials.token.toLowerCase(), expected);
  }

  private async verifyWithMiniserver(username: string, password: string): Promise<boolean> {
    const key = cacheKey(username, password);
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.ok;
    }

    const baseUrl = readMiniserverBaseUrlFromConfig(this.config.getConfig());
    if (!baseUrl) {
      return false;
    }

    let ok = false;
    try {
      // Any valid Miniserver user may stream; admin rights are not required.
      await this.miniserver.verifyCredentials(baseUrl, username, password);
      ok = true;
    } catch (error) {
      if (error instanceof MiniserverAuthError && error.code === 'invalid-credentials') {
        ok = false;
      } else {
        // Unreachable or protocol trouble is not a rejection of the user, but we
        // still cannot let them in. Do not cache it: the Miniserver coming back
        // should take effect immediately, not after the TTL.
        this.log.warn('miniserver verification failed', {
          username,
          message: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    }

    this.cacheVerdict(key, ok, now);
    return ok;
  }

  /** Cache one verification verdict, evicting when the bound is reached. */
  private cacheVerdict(key: string, ok: boolean, now: number): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      // Cheapest sound eviction: drop everything already expired, and if that
      // frees nothing, drop the oldest-inserted entry (Map preserves order).
      for (const [existing, entry] of this.cache) {
        if (entry.expiresAt <= now) {
          this.cache.delete(existing);
        }
      }
      if (this.cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = this.cache.keys().next();
        if (!oldest.done) {
          this.cache.delete(oldest.value);
        }
      }
    }
    this.cache.set(key, { ok, expiresAt: now + (ok ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
  }

  private async rememberVerifiedAccount(username: string, password: string): Promise<void> {
    try {
      const outcome = await rememberLoxoneUser(this.config, username, password, {
        verifiedAt: new Date().toISOString(),
      });
      if (outcome === 'created' || outcome === 'refreshed') {
        this.log.info('recorded miniserver account in the user store', { username, outcome });
      }
    } catch (error) {
      // Bookkeeping must never turn a valid login into a failure.
      this.log.warn('could not record miniserver account', {
        username,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Drop cached verifications, e.g. after the Miniserver config changed. */
  public invalidate(): void {
    this.cache.clear();
  }
}

/**
 * Read the credentials out of a request. Subsonic allows plaintext `p`, the
 * hex-encoded `p=enc:<hex>` (obfuscation, not encryption) and the salted token
 * pair `t`+`s`; clients differ in which they send.
 */
export function readCredentials(params: URLSearchParams): SubsonicCredentials {
  const username = (params.get('u') ?? '').trim();
  if (!username) {
    throw new SubsonicError(SubsonicErrorCode.MissingParameter, 'Required parameter u is missing');
  }

  const token = params.get('t');
  const salt = params.get('s');
  if (token && salt) {
    return { kind: 'token', username, token, salt };
  }

  const supplied = params.get('p');
  if (supplied === null) {
    throw new SubsonicError(SubsonicErrorCode.MissingParameter, 'Required parameter p is missing');
  }
  const password = supplied.startsWith('enc:')
    ? Buffer.from(supplied.slice('enc:'.length), 'hex').toString('utf8')
    : supplied;
  return { kind: 'password', username, password };
}

/** Never key the cache on the plaintext password. */
function cacheKey(username: string, password: string): string {
  return createHash('sha256').update(`${username} ${password}`).digest('hex');
}
