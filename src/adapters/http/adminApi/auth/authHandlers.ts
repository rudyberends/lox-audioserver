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
    const session = deps.sessionStore.create(username);
    res.setHeader('Set-Cookie', deps.sessionStore.buildCookie(req, session));
    deps.sendJson(res, 200, {
      ok: true,
      username,
      tokenRights: result.tokenRights,
      loginAt: session.createdAt,
      expiresAt: session.expiresAt,
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
