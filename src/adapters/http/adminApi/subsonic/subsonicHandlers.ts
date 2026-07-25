import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ComponentLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { Route } from '@/adapters/http/adminApi/routeTypes';
import {
  buildBrowsableServices,
  parseProviderAllowlist,
  providerTitle,
} from '@/adapters/content/browsableServices';
import { musicFolderId } from '@/adapters/subsonic/subsonicIds';
import { SubsonicAuthenticator } from '@/adapters/subsonic/subsonicAuthenticator';
import { listUsers } from '@/application/auth/localUsers';
import { buildBaseUrl } from '@/shared/streamUrl';
import { resolveCoverHost } from '@/shared/utils/net';

/** Bounds for the directory materialisation cap the admin UI can set. */
const DIRECTORY_LIMIT_MIN = 50;
const DIRECTORY_LIMIT_MAX = 10000;
const DIRECTORY_LIMIT_DEFAULT = 1000;

export type SubsonicHandlerDeps = {
  log: ComponentLogger;
  configPort: ConfigPort;
  /** Gateway port, so the status endpoint can hand the UI a ready-to-use client URL. */
  httpPort: number;
  readJsonBody: (req: IncomingMessage, res: ServerResponse, maxBytes?: number) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

/**
 * Admin API for the Subsonic role.
 *
 * `GET /subsonic/status` is the read side. It deliberately returns more than the
 * raw config: the client URL, and the *resolved* service catalogue with a flag
 * per service saying whether the current allowlist exposes it. That is knowledge
 * only the server has — the allowlist filters by provider type while services are
 * per-bridge — so computing it here keeps the UI from re-deriving it and drifting.
 *
 * `POST /subsonic/config` is the write side. It validates rather than merges
 * blindly: enabling without credentials is the mistake that produces a server
 * which answers every client with "not authorized", and it is much better caught
 * here than discovered in a phone app.
 *
 * Both take effect immediately — the Subsonic API reads config per request, and
 * `updateConfig` writes through to the in-memory copy, so there is no restart.
 */
export function buildSubsonicRoutes(deps: SubsonicHandlerDeps): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/subsonic\/status$/,
      handler: (_req, res) => handleStatus(res, deps),
    },
    {
      method: 'POST',
      pattern: /^\/subsonic\/config$/,
      handler: async (req, res) => handleConfigUpdate(req, res, deps),
    },
  ];
}

function handleStatus(res: ServerResponse, deps: SubsonicHandlerDeps): void {
  const cfg = deps.configPort.getConfig();
  const subsonic = cfg.content.subsonic;
  const allow = parseProviderAllowlist(subsonic?.providers);

  // The full catalogue, ignoring the allowlist, so the UI can render every
  // service as a toggle — including the ones currently switched off.
  const all = buildBrowsableServices(deps.configPort, null);
  const services = all.map((service) => ({
    key: service.key,
    provider: service.provider,
    title: service.title,
    musicFolderId: musicFolderId(service.key),
    exposed: !allow || allow.has(service.provider),
    /** Whether this service can answer search3 (radio cannot). */
    searchable: service.searchSource !== null,
  }));

  // Distinct provider types, which is the granularity the allowlist works at.
  const providerOptions = [...new Set(all.map((service) => service.provider))].map((provider) => ({
    provider,
    label: providerTitle(provider),
    enabled: !allow || allow.has(provider),
  }));

  const auth = new SubsonicAuthenticator(deps.configPort).availability();
  const users = listUsers(deps.configPort);

  deps.sendJson(res, 200, {
    enabled: subsonic?.enabled === true,
    /** True when at least one credential source can admit a client. */
    configured: auth.local || auth.loxone,
    /** Accounts live in the shared user store; manage them via /users. */
    users,
    /**
     * Which credential sources apply. In Loxone-integrated mode a Miniserver
     * account is enough, so local credentials are optional; standalone has no
     * Miniserver and therefore requires them.
     */
    auth: {
      loxone: auth.loxone,
      loxoneUnavailableReason: auth.loxoneUnavailableReason,
      localUsers: auth.local,
      localUsersRequired: !auth.loxone,
      /**
       * Salted-token logins (the default in most clients) can only be answered
       * from local credentials — the Miniserver needs the plaintext password,
       * which a token login never carries. Without local credentials such a
       * client must switch to plaintext/legacy authentication.
       */
      tokenAuthSupported: auth.local,
    },
    url: clientUrl(deps),
    directoryLimit: subsonic?.directoryLimit ?? DIRECTORY_LIMIT_DEFAULT,
    directoryLimitBounds: { min: DIRECTORY_LIMIT_MIN, max: DIRECTORY_LIMIT_MAX },
    providers: subsonic?.providers ?? null,
    providerOptions,
    services,
    /**
     * Capabilities the UI should not promise. Annotations are accepted but not
     * persisted (no annotation store), so a client's stars silently vanish.
     */
    limitations: {
      persistsStarsAndRatings: false,
      writablePlaylists: false,
    },
  });
}

/** The base URL a Subsonic client should be pointed at (clients append `/rest`). */
function clientUrl(deps: SubsonicHandlerDeps): string {
  const host = resolveCoverHost(deps.configPort.getConfig().system.audioserver.ip);
  return buildBaseUrl({ host, port: deps.httpPort });
}

type SubsonicConfigBody = {
  enabled?: boolean;
  providers?: string[] | null;
  directoryLimit?: number | null;
};

async function handleConfigUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SubsonicHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as SubsonicConfigBody | null;
  if (res.writableEnded) {
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    deps.sendJson(res, 400, { error: 'invalid-subsonic-payload' });
    return;
  }

  const current = deps.configPort.getConfig().content.subsonic ?? {};
  const nextEnabled = typeof body.enabled === 'boolean' ? body.enabled : current.enabled === true;

  // Accounts are not configured here — they live in the shared user store — but
  // switching the API *on* when nobody can log into it is worth refusing. In
  // Loxone-integrated mode a Miniserver account suffices; standalone needs a
  // local user, created via /users.
  //
  // Only the transition is checked. An already-enabled API in that state is an
  // existing problem, and blocking unrelated edits (say, the allowlist) would
  // make it harder to fix rather than easier.
  const auth = new SubsonicAuthenticator(deps.configPort).availability();
  if (body.enabled === true && !auth.local && !auth.loxone) {
    deps.sendJson(res, 400, {
      error: 'no-usable-credentials',
      message:
        'Create a user (POST /users) before enabling the Subsonic API: this server has no Miniserver to authenticate against',
      loxoneUnavailableReason: auth.loxoneUnavailableReason,
    });
    return;
  }

  let nextProviders: string[] | undefined | null;
  if (body.providers !== undefined) {
    if (body.providers === null) {
      nextProviders = null;
    } else if (!Array.isArray(body.providers)) {
      deps.sendJson(res, 400, { error: 'invalid-providers' });
      return;
    } else {
      const known = new Set(
        buildBrowsableServices(deps.configPort, null).map((service) => service.provider),
      );
      const cleaned = body.providers
        .map((value) => String(value).trim().toLowerCase())
        .filter(Boolean);
      const unknown = cleaned.filter((provider) => !known.has(provider));
      if (unknown.length > 0) {
        deps.sendJson(res, 400, { error: 'unknown-provider', providers: unknown });
        return;
      }
      // An empty list means "no restriction", matching parseProviderAllowlist —
      // storing it as absent keeps the config honest about what it means.
      nextProviders = cleaned.length > 0 ? [...new Set(cleaned)] : null;
    }
  }

  let nextDirectoryLimit: number | undefined | null;
  if (body.directoryLimit !== undefined) {
    if (body.directoryLimit === null) {
      nextDirectoryLimit = null;
    } else {
      const value = Number(body.directoryLimit);
      if (
        !Number.isFinite(value) ||
        value < DIRECTORY_LIMIT_MIN ||
        value > DIRECTORY_LIMIT_MAX
      ) {
        deps.sendJson(res, 400, {
          error: 'invalid-directory-limit',
          min: DIRECTORY_LIMIT_MIN,
          max: DIRECTORY_LIMIT_MAX,
        });
        return;
      }
      nextDirectoryLimit = Math.round(value);
    }
  }

  await deps.configPort.updateConfig((cfg) => {
    const target = { ...(cfg.content.subsonic ?? {}) };
    target.enabled = nextEnabled;
    if (nextProviders !== undefined) {
      if (nextProviders === null) {
        delete target.providers;
      } else {
        target.providers = nextProviders;
      }
    }
    if (nextDirectoryLimit !== undefined) {
      if (nextDirectoryLimit === null) {
        delete target.directoryLimit;
      } else {
        target.directoryLimit = nextDirectoryLimit;
      }
    }
    cfg.content.subsonic = target;
  });

  deps.log.info('subsonic config updated', {
    enabled: nextEnabled,
    providers: nextProviders === undefined ? 'unchanged' : (nextProviders ?? 'all'),
  });

  handleStatus(res, deps);
}
