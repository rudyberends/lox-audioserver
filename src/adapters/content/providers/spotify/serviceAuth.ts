import crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createLogger } from '@/shared/logging/logger';
import { safeReadText } from '@/shared/bestEffort';
import type { SpotifyAccountConfig } from '@/domain/config/types';
import type { ContentManager } from '@/adapters/content/contentManager';
import { consumePkceVerifier } from '@/adapters/content/providers/spotify/pkce';
import { resolveSpotifyClientId } from '@/adapters/content/providers/spotify/utils';
import {
  generateLibrespotCredentialsFromOAuth,
  pairLibrespotCredentialsViaZeroconf,
} from '@/adapters/inputs/spotify/spotifyStreamingService';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createPkcePair } from '@/adapters/content/providers/spotify/pkce';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { SpotifyServiceManagerProvider } from '@/adapters/content/providers/spotifyServiceManager';
import type { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import { pushLibrespotCredentials } from '@/adapters/inputs/spotify/spotifyInputService';
import type { ConfigPort } from '@/ports/ConfigPort';

const SPOTIFY_PUBLIC_REDIRECT_URI = 'https://sonn-audio.github.io/callbacks/spotify/';

const log = createLogger('Content', 'SpotifyAuth');

interface BuildLinkParams {
  audioServerHost: string;
}

export function buildSpotifyAuthLink(params: BuildLinkParams, configPort: ConfigPort): string {
  const cfg = configPort.getConfig();
  const clientId = resolveSpotifyClientId(cfg.content?.spotify);

  const stateKey = `content:spotify:${crypto.randomBytes(8).toString('hex')}`;
  const { codeChallenge } = createPkcePair(stateKey);

  const localCallbackUrl = `http://${params.audioServerHost}:7090/admin/api/spotify/auth/callback?state=${stateKey}`;

  const scope = [
    'playlist-read-private',
    'playlist-read-collaborative',
    'playlist-modify-private',
    'playlist-modify-public',
    'user-library-read',
    'user-library-modify',
    'user-follow-read',
    'user-follow-modify',
    'user-read-email',
    'user-read-private',
    'user-read-currently-playing',
    'app-remote-control',
    'user-modify-playback-state',
    'user-read-playback-state',
    'streaming',
  ].join(' ');

  const paramsStr = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: SPOTIFY_PUBLIC_REDIRECT_URI,
    scope,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    state: encodeURIComponent(localCallbackUrl),
  });

  const link = `https://accounts.spotify.com/authorize?${paramsStr.toString()}`;
  log.debug('Built Spotify auth link');
  return link;
}

/**
 * Handle the OAuth callback from Spotify (PKCE flow).
 *
 * - Exchanges the authorization code for a refresh token
 * - Fetches the /me profile to populate display information
 * - Persists/merges the account into cfg.content.spotify.accounts
 * - Triggers an in-memory reload of the content manager
 */
export async function handleSpotifyOAuthCallback(
  req: { url?: string },
  res: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body?: string) => void },
  notifier: NotifierPort,
  configPort: ConfigPort,
  contentManager: ContentManager,
  spotifyInputService: SpotifyInputService,
): Promise<void> {
  const { searchParams } = new URL(req.url ?? '', 'http://localhost');
  let code = searchParams.get('code') ?? '';
  let state = searchParams.get('state') ?? '';
  const error = searchParams.get('error');

  if (error) {
    return renderError(res, 400, 'Spotify authentication failed', error);
  }

  ({ code, state } = extractCodeAndState(code, state));
  if (!code || !state) {
    return renderError(res, 400, 'Invalid Spotify callback');
  }

  const codeVerifier = consumePkceVerifier(state);
  if (!codeVerifier) {
    return renderError(res, 400, 'Spotify authentication session expired');
  }

  try {
    const cfg = configPort.getConfig();
    const clientId = resolveSpotifyClientId(cfg.content?.spotify);

    const tokens = await exchangeCodeForToken({
      code,
      clientId,
      redirectUri: SPOTIFY_PUBLIC_REDIRECT_URI,
      codeVerifier,
    });

    const refreshToken = tokens.refresh_token?.trim();
    const accessToken = tokens.access_token?.trim();
    if (!refreshToken) {
      return renderError(res, 400, 'Spotify did not return a refresh token');
    }

    const profile = accessToken ? await loadSpotifyProfile(accessToken) : null;
    if (!profile?.id) {
      return renderError(res, 400, 'Spotify profile missing id or access not granted');
    }

    const displayName = profile.display_name?.trim() || profile.email || profile.id || 'Spotify User';
    // Align id/user/name/displayName to the same human-friendly value so downstream
    // queue metadata always uses the friendly account name instead of the raw Spotify id.
    const accountId = displayName;
    const spotifyId = profile.id;

    await persistAccount(configPort, {
      id: accountId,
      spotifyId,
      user: accountId,
      email: profile.email,
      country: profile.country,
      clientId,
      product: profile.product,
      displayName,
      name: displayName,
      refreshToken,
    });

    if (accessToken) {
      try {
        const creds = await generateLibrespotCredentialsFromOAuth({
          accessToken,
          deviceName: accountId,
        });
        if (creds?.credentials) {
          let parsed: string | Record<string, unknown> = creds.credentials;
          try {
            parsed = JSON.parse(creds.credentials);
          } catch {
            /* keep string */
          }
          await pushLibrespotCredentials(spotifyInputService, accountId, parsed);
          log.info('librespot oauth credentials stored after account creation', { accountId });
        } else {
          log.warn('librespot oauth credentials unavailable after account creation', { accountId });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn('librespot oauth credential generation failed after account creation', {
          accountId,
          message,
        });
      }
    }

    // Make the new account immediately available without restart
    contentManager.refreshFromConfig();
    notifier.notifyReloadMusicApp('useradd', 'spotify', accountId);
    reinitializeSpotifyInputs(configPort, spotifyInputService, 'account_created', accountId);

    return renderSuccess(res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return renderError(res, 500, 'Spotify authentication error', message);
  }
}

/**
 * Use existing OAuth token (refresh flow) to mint librespot credentials.
 * Request body (JSON): { accountId, deviceName? }
 */
export async function handleSpotifyLibrespotOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  configPort: ConfigPort,
  spotifyInputService: SpotifyInputService,
  spotifyManagers: SpotifyServiceManagerProvider,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }

  const body = (await readJsonBody(req)) as { accountId?: string; deviceName?: string } | null;
  const accountId = (body?.accountId || '').trim();
  const deviceName = (body?.deviceName || '').trim() || accountId || 'lox-spotify';

  if (!accountId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing_account' }));
    return;
  }

  const account = findSpotifyAccount(configPort, accountId);
  if (!account) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'account_not_found' }));
    return;
  }

  const spotifyManager = spotifyManagers.get();
  const accessToken = await spotifyManager.getAccessTokenForAccount(accountId);
  if (!accessToken) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing_access_token' }));
    return;
  }

  try {
    const result = await generateLibrespotCredentialsFromOAuth({
      accessToken,
      deviceName,
    });
    if (!result) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'oauth_login_failed' }));
      return;
    }
    let parsed: string | Record<string, unknown> = result.credentials;
    try {
      parsed = JSON.parse(result.credentials);
    } catch {
      /* keep string */
    }
    await pushLibrespotCredentials(spotifyInputService, accountId, parsed);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, username: result.username }));
    reinitializeSpotifyInputs(configPort, spotifyInputService, 'oauth_credentials_updated', accountId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('librespot oauth credential generation failed', { accountId, message });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'librespot_oauth_failed', message }));
  }
}

/**
 * A pairing handshake in flight, per account.
 *
 * Pairing finishes when a person picks the device in the Spotify app, so it is held here rather than
 * on the request: a browser will not sit on a POST for two minutes, and the admin screen needs
 * something to poll while it tells the user what to go and tap.
 */
type PairingState = {
  state: 'pairing' | 'paired' | 'failed';
  deviceName: string;
  startedAt: number;
  expiresAt: number;
  username?: string;
  error?: string;
};

const pairingByAccount = new Map<string, PairingState>();
const PAIRING_RESULT_TTL_MS = 5 * 60 * 1000;

function pairingSnapshot(accountId: string): PairingState | null {
  const entry = pairingByAccount.get(accountId);
  if (!entry) {
    return null;
  }
  // A settled result is worth keeping only long enough for the screen that asked to read it.
  if (entry.state !== 'pairing' && Date.now() - entry.expiresAt > PAIRING_RESULT_TTL_MS) {
    pairingByAccount.delete(accountId);
    return null;
  }
  if (entry.state === 'pairing' && Date.now() > entry.expiresAt) {
    entry.state = 'failed';
    entry.error = 'timed_out';
  }
  return entry;
}

function findSpotifyAccount(
  configPort: ConfigPort,
  accountId: string,
): SpotifyAccountConfig | undefined {
  return configPort
    .getConfig()
    .content?.spotify?.accounts?.find(
      (acc) =>
        acc.id === accountId ||
        acc.user === accountId ||
        acc.email === accountId ||
        acc.spotifyId === accountId,
    );
}

/**
 * Pair an account by handshake, the only login Spotify still accepts (#333).
 *
 * POST /admin/api/spotify/librespot/zeroconf { accountId, deviceName?, timeoutMs? }
 *   Starts advertising and returns immediately with the device name to show the user.
 * GET  /admin/api/spotify/librespot/zeroconf?accountId=<id>
 *   Reports how it is going: pairing | paired | failed.
 *
 * One handshake per account at a time — a second advertisement for the same account would just
 * compete with the first for the same pick.
 */
export async function handleSpotifyLibrespotZeroconf(
  req: IncomingMessage,
  res: ServerResponse,
  configPort: ConfigPort,
  spotifyInputService: SpotifyInputService,
  contentManager: ContentManager,
): Promise<void> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET') {
    const { searchParams } = new URL(req.url ?? '', 'http://localhost');
    const accountId = (searchParams.get('accountId') || '').trim();
    if (!accountId) {
      return json(400, { error: 'missing_account' });
    }
    const entry = pairingSnapshot(accountId);
    if (!entry) {
      return json(200, { ok: true, state: 'idle' });
    }
    return json(200, {
      ok: true,
      state: entry.state,
      deviceName: entry.deviceName,
      expiresAt: entry.expiresAt,
      username: entry.username,
      error: entry.error,
    });
  }

  if (req.method !== 'POST') {
    return json(405, { error: 'method_not_allowed' });
  }

  const body = (await readJsonBody(req)) as
    | { accountId?: string; deviceName?: string; timeoutMs?: number }
    | null;
  const accountId = (body?.accountId || '').trim();
  if (!accountId) {
    return json(400, { error: 'missing_account' });
  }

  const account = findSpotifyAccount(configPort, accountId);
  if (!account) {
    return json(404, { error: 'account_not_found' });
  }

  const existing = pairingSnapshot(accountId);
  if (existing?.state === 'pairing') {
    return json(200, {
      ok: true,
      state: 'pairing',
      deviceName: existing.deviceName,
      expiresAt: existing.expiresAt,
      alreadyRunning: true,
    });
  }

  const deviceName = (body?.deviceName || '').trim() || 'Sonn (pairing)';
  const timeoutMs =
    typeof body?.timeoutMs === 'number' && Number.isFinite(body.timeoutMs)
      ? Math.max(30_000, Math.min(300_000, body.timeoutMs))
      : 120_000;
  // librespot device ids are 40-hex; derive one from the account so repeat pairings reuse it
  // instead of leaving a trail of one-off devices in the user's Spotify app.
  const deviceId = crypto.createHash('sha1').update(`pair:${accountId}`).digest('hex');

  const entry: PairingState = {
    state: 'pairing',
    deviceName,
    startedAt: Date.now(),
    expiresAt: Date.now() + timeoutMs,
  };
  pairingByAccount.set(accountId, entry);
  log.info('spotify zeroconf pairing started', { accountId, deviceName, timeoutMs });

  void (async () => {
    try {
      const result = await pairLibrespotCredentialsViaZeroconf({
        deviceId,
        name: deviceName,
        timeoutMs,
      });
      if (!result) {
        entry.state = 'failed';
        entry.error = 'no_credentials';
        log.warn('spotify zeroconf pairing produced no credentials', { accountId });
        return;
      }
      let parsed: string | Record<string, unknown> = result.credentials;
      try {
        parsed = JSON.parse(result.credentials);
      } catch {
        /* keep string */
      }
      await pushLibrespotCredentials(spotifyInputService, accountId, parsed);
      entry.state = 'paired';
      entry.username = result.username;
      log.info('spotify zeroconf pairing stored', { accountId, username: result.username });
      reinitializeSpotifyInputs(configPort, spotifyInputService, 'zeroconf_paired', accountId);
      // Browsing holds its own librespot session, built once and cached on the content provider.
      // Rebuilding the providers is what drops it, so without this the pathfinder keeps minting
      // tokens off the credentials that were just replaced and browse stays broken while playback
      // recovers.
      contentManager.refreshFromConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry.state = 'failed';
      entry.error = message;
      log.warn('spotify zeroconf pairing failed', { accountId, message });
    }
  })();

  return json(202, { ok: true, state: 'pairing', deviceName, expiresAt: entry.expiresAt });
}

/**
 * Export existing librespot credentials for an account.
 * Request (GET): /admin/api/spotify/librespot/credentials?accountId=<id>
 * Response: { username, credentials }
 */
export async function handleSpotifyLibrespotExport(
  req: IncomingMessage,
  res: ServerResponse,
  configPort: ConfigPort,
): Promise<void> {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }
  const { searchParams } = new URL(req.url ?? '', 'http://localhost');
  const accountId = (searchParams.get('accountId') || '').trim();
  if (!accountId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing_account' }));
    return;
  }
  const account = findSpotifyAccount(configPort, accountId);
  if (!account) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'account_not_found' }));
    return;
  }

  // Prefer credentials stored in config, else read from cache dir.
  let credentials: string | null = null;
  const librespotCreds = (account as { librespotCredentials?: unknown }).librespotCredentials;
  if (librespotCreds) {
    try {
      credentials =
        typeof librespotCreds === 'string'
          ? librespotCreds
          : JSON.stringify(librespotCreds, null, 2);
    } catch {
      credentials = null;
    }
  }

  if (!credentials) {
    const cacheDir = `/tmp/lox-librespot-accounts/${accountId}`;
    const credPath = path.join(cacheDir, 'credentials.json');
    try {
      const buf = await fsp.readFile(credPath, 'utf8');
      credentials = buf;
    } catch {
      /* ignore */
    }
  }

  if (!credentials) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'credentials_not_found' }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, username: account.user || account.id, credentials }));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export async function deleteSpotifyAccount(
  configPort: ConfigPort,
  userId: string,
  notifier: NotifierPort,
  contentManager: ContentManager,
  spotifyInputService: SpotifyInputService,
): Promise<void> {
  if (!userId) {
    return;
  }

  await configPort.updateConfig((cfg) => {
    const accounts = cfg.content.spotify.accounts || [];
    const next: SpotifyAccountConfig[] = accounts.filter(
      (acc) =>
        !(
          acc &&
          ((acc.id && acc.id === userId) ||
            (acc.user && acc.user === userId) ||
            (acc.email && acc.email === userId))
        ),
    );

    if (next.length !== accounts.length) {
      cfg.content.spotify.accounts = next;
      log.info('Removed Spotify account from config', { userId });
    }
  });

  // Refresh runtime providers and notify clients
  contentManager.refreshFromConfig();
  notifier.notifyReloadMusicApp('userdel', 'spotify', userId);
  reinitializeSpotifyInputs(configPort, spotifyInputService, 'account_deleted', userId);
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
};

async function exchangeCodeForToken(params: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.codeVerifier,
  });

  const resp = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!resp.ok) {
    const detail = await safeReadText(resp, '', {
      onError: 'debug',
      log,
      label: 'spotify token response read failed',
      context: { status: resp.status },
    });
    throw new Error(`Spotify token exchange failed: ${detail.slice(0, 400)}`);
  }

  return (await resp.json()) as TokenResponse;
}

type SpotifyProfile = {
  id?: string;
  display_name?: string;
  email?: string;
  product?: string;
  country?: string;
};

async function loadSpotifyProfile(accessToken: string): Promise<SpotifyProfile | null> {
  try {
    const resp = await fetch('https://api.spotify.com/v1/me', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    if (!resp.ok) {
      const detail = await safeReadText(resp, '', {
        onError: 'debug',
        log,
        label: 'spotify token refresh response read failed',
        context: { status: resp.status },
      });
      log.warn('spotify /me request failed', {
        status: resp.status,
        body: detail.slice(0, 200),
      });
      return null;
    }
    const data = (await resp.json()) as SpotifyProfile;
    if (!data?.id) {
      log.warn('spotify /me response missing id', {
        email: data?.email,
        display_name: data?.display_name,
      });
    }
    return data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('spotify /me request error', { message });
    return null;
  }
}

async function persistAccount(configPort: ConfigPort, account: SpotifyAccountConfig): Promise<void> {
  await configPort.updateConfig((cfg) => {
    const accounts = cfg.content.spotify.accounts ?? [];
    const idx = accounts.findIndex(
      (acc) =>
        (acc.id && account.id && acc.id === account.id) ||
        (acc.spotifyId && account.spotifyId && acc.spotifyId === account.spotifyId) ||
        (acc.email && account.email && acc.email === account.email) ||
        (acc.user && account.user && acc.user === account.user),
    );

    if (idx >= 0) {
      accounts[idx] = { ...accounts[idx], ...account };
    } else {
      accounts.push(account);
    }

    cfg.content.spotify.accounts = accounts;
  });
}

function reinitializeSpotifyInputs(
  configPort: ConfigPort,
  spotifyInputService: SpotifyInputService,
  reason: string,
  accountId?: string,
): void {
  try {
    const cfg = configPort.getConfig();
    const zones = cfg.zones ?? [];
    const spotifyCfg = cfg.inputs?.spotify ?? null;
    spotifyInputService.syncZones(zones, spotifyCfg);
    if (accountId) {
      const account = cfg.content?.spotify?.accounts?.find(
        (acc) =>
          acc.id === accountId ||
          acc.user === accountId ||
          acc.email === accountId ||
          acc.spotifyId === accountId,
      );
      const accountCreds = (account as { librespotCredentials?: unknown } | undefined)?.librespotCredentials;
      if (accountCreds) {
        pushLibrespotCredentials(spotifyInputService, accountId, accountCreds as string | Record<string, unknown>).catch(
          (error) => {
            const message = error instanceof Error ? error.message : String(error);
            log.warn('spotify librespot credential push failed during reinit', {
              reason,
              accountId,
              message,
            });
          },
        );
      }
    }
    log.info('spotify inputs reinitialized', { reason, accountId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('spotify inputs reinit failed', { reason, accountId, message });
  }
}

function extractCodeAndState(code: string, state: string): { code: string; state: string } {
  let normalizedCode = code?.trim() ?? '';
  let normalizedState = state?.trim() ?? '';

  // Some redirect flows append ?code=... directly onto state
  const stateQueryIdx = normalizedState.indexOf('?code=');
  if (stateQueryIdx >= 0) {
    const embedded = normalizedState.slice(stateQueryIdx + '?code='.length);
    const [codeFromState] = embedded.split('&');
    if (!normalizedCode && codeFromState) {
      normalizedCode = decodeURIComponent(codeFromState);
    }
    normalizedState = normalizedState.slice(0, stateQueryIdx);
  }

  // state may contain the local callback URL; peel off nested params if present
  try {
    const decoded = decodeURIComponent(normalizedState);
    if (decoded.startsWith('http')) {
      const nested = new URL(decoded);
      normalizedState = nested.searchParams.get('state') ?? normalizedState;
      if (!normalizedCode) {
        normalizedCode = nested.searchParams.get('code') ?? normalizedCode;
      }
    }
  } catch {
    /* ignore */
  }

  return { code: normalizedCode, state: normalizedState };
}

function renderError(
  res: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body?: string) => void },
  status: number,
  title: string,
  detail = '',
) {
  res.writeHead(status, { 'Content-Type': 'text/html' });
  res.end(`<h1>${title}</h1><pre>${detail}</pre>`);
}

function renderSuccess(res: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body?: string) => void }) {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Spotify Account Linked</title>
</head>
<body style="background:#000;color:#fff;display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif;">
  <div style="text-align:center;">
    <p>Spotify account linked. You can close this window.</p>
  </div>
  <script>
    window.open('', '_self'); window.close();
    setTimeout(() => { document.querySelector('p').textContent = 'You can close this window.'; }, 300);
  </script>
</body>
</html>`,
  );
}
