import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ComponentLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { Route } from '@/adapters/http/adminApi/routeTypes';
import { hasAdminUser, listUsers, removeUser, saveUser } from '@/application/auth/localUsers';

const MAX_CREDENTIAL_LENGTH = 128;
const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;

export type UsersHandlerDeps = {
  log: ComponentLogger;
  configPort: ConfigPort;
  readJsonBody: (req: IncomingMessage, res: ServerResponse, maxBytes?: number) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

/**
 * Admin API for the server's own accounts.
 *
 * These accounts back both the admin UI and the Subsonic API, so this is the one
 * place to add someone. `admin: true` grants configuration access; without it an
 * account can stream but not log into the admin UI — which is what a household
 * member should get.
 *
 * Passwords are never returned. They are stored in the clear (Subsonic's
 * salted-token login requires a recoverable secret, see {@link UserAccount}), so
 * not echoing them back keeps them out of browser caches, logs and screenshots.
 */
export function buildUsersRoutes(deps: UsersHandlerDeps): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/users$/,
      handler: (_req, res) => handleList(res, deps),
    },
    {
      method: 'POST',
      pattern: /^\/users$/,
      handler: async (req, res) => handleUpsert(req, res, deps),
    },
    {
      method: 'DELETE',
      pattern: /^\/users\/([^/]+)$/,
      handler: async (_req, res, match) =>
        handleDelete(decodeURIComponent(match[1] ?? ''), res, deps),
    },
  ];
}

function handleList(res: ServerResponse, deps: UsersHandlerDeps): void {
  deps.sendJson(res, 200, { users: listUsers(deps.configPort) });
}

type UpsertBody = {
  username?: string;
  /** Omit on an update to keep the stored password. */
  password?: string;
  admin?: boolean;
  label?: string;
};

async function handleUpsert(
  req: IncomingMessage,
  res: ServerResponse,
  deps: UsersHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as UpsertBody | null;
  if (res.writableEnded) {
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    deps.sendJson(res, 400, { error: 'invalid-user-payload' });
    return;
  }

  const username = typeof body.username === 'string' ? body.username.trim() : '';
  if (!USERNAME_PATTERN.test(username)) {
    // Constrained because the name travels in URLs and Subsonic query strings.
    deps.sendJson(res, 400, { error: 'invalid-username' });
    return;
  }

  const existing = (deps.configPort.getConfig().system?.users ?? []).find(
    (user) => user?.username?.trim() === username,
  );
  if (typeof body.password === 'string' && body.password.length > MAX_CREDENTIAL_LENGTH) {
    deps.sendJson(res, 400, { error: 'credential-too-long', max: MAX_CREDENTIAL_LENGTH });
    return;
  }
  if (typeof body.password !== 'string' && !existing?.password) {
    deps.sendJson(res, 400, { error: 'password-required' });
    return;
  }

  await saveUser(deps.configPort, {
    username,
    ...(typeof body.password === 'string' ? { password: body.password } : {}),
    ...(typeof body.admin === 'boolean' ? { admin: body.admin } : {}),
    ...(typeof body.label === 'string' ? { label: body.label.trim() } : {}),
    // Editing an entry by hand makes it locally managed, so a later Loxone
    // login will not overwrite it.
    source: 'local',
  });

  deps.log.info('user saved', { username });
  handleList(res, deps);
}

async function handleDelete(
  username: string,
  res: ServerResponse,
  deps: UsersHandlerDeps,
): Promise<void> {
  const wanted = username.trim();
  const users = deps.configPort.getConfig().system?.users ?? [];
  if (!users.some((user) => user?.username?.trim() === wanted)) {
    deps.sendJson(res, 404, { error: 'unknown-user' });
    return;
  }

  // Removing the last admin would leave nobody able to configure the server, and
  // in standalone mode nothing else can let an operator back in.
  const remainingAdmins = users.filter(
    (user) => user?.admin === true && user?.username?.trim() !== wanted,
  ).length;
  const paired = deps.configPort.getConfig().system?.audioserver?.paired === true;
  if (remainingAdmins === 0 && hasAdminUser(deps.configPort) && !paired) {
    deps.sendJson(res, 409, {
      error: 'last-admin',
      message: 'Cannot remove the only admin account while no Miniserver pairing exists',
    });
    return;
  }

  await removeUser(deps.configPort, wanted);
  deps.log.info('user removed', { username: wanted });
  handleList(res, deps);
}
