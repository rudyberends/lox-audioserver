import crypto from 'node:crypto';
import { createLogger } from '@/shared/logging/logger';
import {
  YtMusicCookieExpiredError,
  YtMusicInnertubeError,
  getCookieValue,
  ytmBrowse,
} from '@/adapters/content/providers/ytmusic/ytmusicInnertube';

const log = createLogger('Content', 'YTMusicAuth');

/**
 * What the configured YouTube Music cookie is currently worth.
 *
 * `expired` is the state this file exists for. YouTube rotates account cookies on
 * open browser tabs as a security measure, so a cookie copied out of a live session
 * stops identifying anyone within the hour — and it stops silently, answering 200
 * with a sign-in prompt. Before this, that turned into a `log.warn` and an empty
 * library, which is exactly what "my library is gone" looked like from the outside
 * with nothing telling anyone to paste a new cookie.
 */
export type YtMusicAuthState = 'ok' | 'expired' | 'invalid' | 'missing' | 'unknown';

export type YtMusicAuthStatus = {
  state: YtMusicAuthState;
  /** When this was last established, or null when never checked. */
  checkedAt: number | null;
  /** Detail worth showing a user, when there is any. */
  message: string | null;
};

const UNKNOWN: YtMusicAuthStatus = { state: 'unknown', checkedAt: null, message: null };

const statusByBridgeId = new Map<string, YtMusicAuthStatus>();

export function getYtMusicAuthStatus(bridgeId: string): YtMusicAuthStatus {
  return statusByBridgeId.get(bridgeId) ?? UNKNOWN;
}

export function getAllYtMusicAuthStatuses(): Record<string, YtMusicAuthStatus> {
  return Object.fromEntries(statusByBridgeId);
}

export function recordYtMusicAuth(bridgeId: string, state: YtMusicAuthState, message?: string | null): void {
  const id = String(bridgeId || '').trim();
  if (!id) return;
  const previous = statusByBridgeId.get(id);
  statusByBridgeId.set(id, { state, checkedAt: Date.now(), message: message ?? null });
  if (previous?.state === state) return;
  // Only on a change: a browse per library section would otherwise log this six times.
  if (state === 'expired') {
    log.warn('ytmusic cookie expired; library needs a freshly pasted cookie', { bridgeId: id });
  } else if (state === 'ok' && previous && previous.state !== 'ok') {
    log.info('ytmusic cookie accepted again', { bridgeId: id });
  }
}

export function forgetYtMusicAuth(bridgeId: string): void {
  statusByBridgeId.delete(bridgeId);
}

/**
 * Ask YouTube Music directly whether a cookie still works.
 *
 * Used both when a cookie is saved — so a cookie that was already dead when pasted
 * is rejected while the user is still looking at the field — and by the setup
 * screen's check button.
 */
export async function verifyYtMusicCookie(cookie: string): Promise<YtMusicAuthStatus> {
  const value = String(cookie || '').trim();
  if (!value) {
    return { state: 'missing', checkedAt: Date.now(), message: null };
  }
  // Checked before asking, because without it the request cannot even be signed, and
  // "wrong thing pasted" deserves a different sentence than "session expired".
  if (!getCookieValue(value, '__Secure-3PAPISID') && !getCookieValue(value, 'SAPISID')) {
    return {
      state: 'invalid',
      checkedAt: Date.now(),
      message: 'The cookie is missing __Secure-3PAPISID, so it cannot be from a signed-in session.',
    };
  }

  try {
    await ytmBrowse('FEmusic_liked_albums', { cookie: value, hl: 'en' });
    return { state: 'ok', checkedAt: Date.now(), message: null };
  } catch (err) {
    if (err instanceof YtMusicCookieExpiredError) {
      return { state: 'expired', checkedAt: Date.now(), message: null };
    }
    if (err instanceof YtMusicInnertubeError) {
      // 401/403 would be the honest answer to a dead cookie; treat it as one.
      if (err.status === 401 || err.status === 403) {
        return { state: 'expired', checkedAt: Date.now(), message: null };
      }
      return {
        state: 'unknown',
        checkedAt: Date.now(),
        message: `YouTube Music could not be reached (HTTP ${err.status ?? '?'}).`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { state: 'unknown', checkedAt: Date.now(), message };
  }
}

/**
 * Establish a cookie's verdict without waiting for someone to browse.
 *
 * Recording the verdict as requests happen answers "why is my library empty" only
 * once the library has been asked for, which on a fresh server is never — the state
 * reads `unknown` and the setup screen has nothing to show. So each configured
 * account is checked once in the background when it is registered.
 *
 * Deduped on the cookie itself: config refreshes rebuild providers freely, and this
 * must not turn each one into another request to YouTube. A changed cookie is a new
 * signature and gets checked again immediately.
 */
const CHECK_TTL_MS = 6 * 60 * 60_000;

const checksByBridgeId = new Map<string, { signature: string; checkedAt: number }>();

export function scheduleYtMusicCookieCheck(bridgeId: string, cookie: string | undefined): void {
  const id = String(bridgeId || '').trim();
  const value = typeof cookie === 'string' ? cookie.trim() : '';
  if (!id) return;
  if (!value) {
    // Nothing to ask YouTube about; the account is simply not configured yet.
    recordYtMusicAuth(id, 'missing');
    return;
  }

  const signature = crypto.createHash('sha256').update(value).digest('hex');
  const previous = checksByBridgeId.get(id);
  if (previous && previous.signature === signature && Date.now() - previous.checkedAt < CHECK_TTL_MS) {
    return;
  }
  // Claimed before the request so concurrent refreshes cannot both start one.
  checksByBridgeId.set(id, { signature, checkedAt: Date.now() });

  const timer = setTimeout(() => {
    void (async () => {
      try {
        const verdict = await verifyYtMusicCookie(value);
        recordYtMusicAuth(id, verdict.state, verdict.message);
      } catch (err) {
        // Never a startup failure: an unreachable YouTube says nothing about the cookie.
        log.debug('ytmusic background cookie check failed', {
          bridgeId: id,
          message: err instanceof Error ? err.message : String(err),
        });
        checksByBridgeId.delete(id);
      }
    })();
  }, 0);
  timer.unref?.();
}
