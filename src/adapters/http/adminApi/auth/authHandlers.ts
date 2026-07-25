import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ComponentLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { Route } from '@/adapters/http/adminApi/routeTypes';
import type { AdminSessionStore } from '@/adapters/http/adminApi/auth/adminSessionStore';
import {
  MiniserverAuthClient,
  readMiniserverBaseUrlFromConfig,
} from '@/adapters/http/adminApi/auth/miniserverAuthClient';
import { MiniserverAuthError } from '@/adapters/http/adminApi/auth/types';
import { rememberLoxoneUser, verifyUser } from '@/application/auth/localUsers';

export type AuthHandlerDeps = {
  configPort: ConfigPort;
  sessionStore: AdminSessionStore;
  miniserverAuthClient: MiniserverAuthClient;
  log: ComponentLogger;
  readJsonBody: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, payload: unknown) => void;
};

export function buildAuthRoutes(deps: AuthHandlerDeps): Route[] {
  return [
    {
      method: 'POST',
      pattern: /^\/auth\/login$/,
      handler: async (req, res) => handleAuthLogin(req, res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/auth\/me$/,
      handler: async (req, res) => handleAuthMe(req, res, deps),
    },
    {
      method: 'POST',
      pattern: /^\/auth\/logout$/,
      handler: async (req, res) => handleAuthLogout(req, res, deps),
    },
  ];
}

async function handleAuthLogin(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AuthHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as { username?: string; password?: string } | null;
  if (res.writableEnded) return;

  const username = body?.username?.trim() ?? '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!username || !password) {
    deps.sendJson(res, 400, { error: 'invalid-auth-payload' });
    return;
  }

  const cfg = deps.configPort.getConfig();

  // Server-local accounts first. They are the only way in for a standalone
  // deployment, and in integrated mode they work alongside Miniserver users.
  // Only admin accounts may reach the admin UI; a stream-only account exists for
  // the Subsonic API and must not become a configuration login.
  const localUser = verifyUser(deps.configPort, username, password);
  if (localUser) {
    if (!localUser.admin) {
      deps.log.warn('local login refused: not an admin account', { username });
      deps.sendJson(res, 403, { error: 'insufficient-permissions' });
      return;
    }
    const session = deps.sessionStore.create(username);
    res.setHeader('Set-Cookie', deps.sessionStore.buildCookie(req, session));
    deps.sendJson(res, 200, {
      ok: true,
      username,
      source: 'local',
      tokenRights: null,
      loginAt: session.createdAt,
      expiresAt: session.expiresAt,
      token: session.id,
    });
    return;
  }

  if (!cfg.system.audioserver.paired) {
    deps.sendJson(res, 409, { error: 'miniserver-auth-required' });
    return;
  }
  const miniserverBaseUrl = readMiniserverBaseUrlFromConfig(cfg);
  if (!miniserverBaseUrl) {
    deps.sendJson(res, 409, { error: 'miniserver-not-configured' });
    return;
  }

  try {
    const result = await deps.miniserverAuthClient.verifyAdminCredentials(miniserverBaseUrl, username, password);

    // This is the only moment the server holds a Miniserver password in the
    // clear — the Miniserver itself keeps a salted hash and can never hand it
    // back. Recording it (encrypted) is what lets this Loxone account be used
    // from a Subsonic client afterwards, including the salted-token form that
    // most apps default to and that cannot be delegated to the Miniserver.
    try {
      const outcome = await rememberLoxoneUser(deps.configPort, username, password, {
        admin: true,
        verifiedAt: new Date().toISOString(),
      });
      if (outcome !== 'unchanged') {
        deps.log.info('recorded miniserver account in the user store', { username, outcome });
      }
    } catch (storeError) {
      // Never fail a valid login over bookkeeping.
      deps.log.warn('could not record miniserver account', {
        username,
        message: storeError instanceof Error ? storeError.message : String(storeError),
      });
    }

    const session = deps.sessionStore.create(username);
    res.setHeader('Set-Cookie', deps.sessionStore.buildCookie(req, session));
    deps.sendJson(res, 200, {
      ok: true,
      username,
      tokenRights: result.tokenRights,
      loginAt: session.createdAt,
      expiresAt: session.expiresAt,
      // Same session id as the cookie, exposed so the admin UI can authenticate cross-origin
      // (Authorization: Bearer) when switching to a peer audioserver. Same-origin keeps the cookie.
      token: session.id,
    });
  } catch (err) {
    if (err instanceof MiniserverAuthError) {
      deps.log.warn('miniserver auth failed', { code: err.code, message: err.message, username, miniserverBaseUrl });
      if (err.code === 'invalid-credentials') {
        deps.sendJson(res, 401, { error: err.code });
        return;
      }
      if (err.code === 'insufficient-permissions') {
        deps.sendJson(res, 403, { error: err.code });
        return;
      }
      if (err.code === 'miniserver-not-configured') {
        deps.sendJson(res, 409, { error: err.code });
        return;
      }
      deps.sendJson(res, 502, { error: err.code, miniserverHost: miniserverBaseUrl, message: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    deps.log.warn('miniserver auth failed', { message, username });
    deps.sendJson(res, 502, { error: 'miniserver-unreachable', miniserverHost: miniserverBaseUrl });
  }
}

async function handleAuthMe(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AuthHandlerDeps,
): Promise<void> {
  const session = deps.sessionStore.getFromRequest(req);
  if (!session) {
    deps.sendJson(res, 401, { error: 'auth-required' });
    return;
  }
  deps.sendJson(res, 200, { ok: true, username: session.username, loginAt: session.createdAt, expiresAt: session.expiresAt });
}

async function handleAuthLogout(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AuthHandlerDeps,
): Promise<void> {
  deps.sessionStore.clearFromRequest(req);
  res.setHeader('Set-Cookie', deps.sessionStore.buildExpiredCookie(req));
  deps.sendJson(res, 204, {});
}
