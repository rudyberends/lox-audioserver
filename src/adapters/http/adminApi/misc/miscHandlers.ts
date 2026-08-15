import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, promises as fs, existsSync, readFileSync } from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { readBuildChannel, readBuildVersion, readPackageVersion } from '@/shared/serverVersion';
import type { ComponentLogger } from '@/shared/logging/logger';
import { logManager } from '@/shared/logging/logger';
import { logBuffer } from '@/shared/logging/logBuffer';
import type { LogLevel } from '@/types/logLevel';
import type { ConfigPort } from '@/ports/ConfigPort';
import { hasAdminUser } from '@/application/auth/localUsers';
import type { GroupManagerReadPort } from '@/application/groups/groupManager';
import type { SnapcastCore } from '@/adapters/outputs/snapcast/snapcastCore';
import type { Route } from '@/adapters/http/adminApi/routeTypes';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import type { SonnCorePeerRegistry } from '@/adapters/discovery/sonnCorePeerRegistry';
import { buildAudioServersList } from '@/adapters/discovery/audioServersList';
import { defaultConfig } from '@/adapters/http/adminApi/config/configHandlers';
import { fetchUpstreamJson } from '@/adapters/http/adminApi/misc/upstreamJson';
import { createUpdateChecker } from '@/adapters/http/adminApi/misc/updateCheck';

const ADDON_PACKAGE_PREFIX = '@sonn-audio/node-';

function ttlFromEnv(name: string, fallbackMs: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : fallbackMs;
}

/**
 * One checker for the whole process, so every admin browser, tab and device behind one
 * IP shares a single set of upstream queries instead of each spending from the same
 * GitHub budget on every page load.
 *
 * GitHub release lookups are rate-limited (60 req/h per IP unauthenticated, 5000 with
 * a `GITHUB_TOKEN`) so core/UI/player tags refresh on a slow cadence. npm has no such
 * limit, so component packages refresh fast — that is where "new version → button
 * within ~a minute, no page refresh" comes from. Both TTLs are overridable (seconds).
 */
const updateChecker = createUpdateChecker({
  fetchJson: fetchUpstreamJson,
  declaredPackages: () => readDeclaredAddonPackages(),
  githubTtlMs: ttlFromEnv('UPDATE_CHECK_GITHUB_TTL_S', 15 * 60 * 1000),
  npmTtlMs: ttlFromEnv('UPDATE_CHECK_NPM_TTL_S', 60 * 1000),
});

type AdminUiUpdateRequest = { release?: string };

type AdminUiUpdateResult = {
  ok: boolean;
  release: string;
  distUrl: string;
  targetDir: string;
  updatedAt?: string;
  error?: string;
};

/** Result of a server-core update. Extends the web-bundle shape with the
 *  dependency-sync + restart signals that only apply to the backend. */
type ServerUpdateResult = {
  ok: boolean;
  release: string;
  distUrl: string;
  targetDir: string;
  /** True when the lockfile changed and `npm ci` was run. */
  depsChanged?: boolean;
  /** New code is staged but only takes effect after a process restart. */
  restartRequired?: boolean;
  /** Whether this deployment will restart itself (containerized/supervised). */
  willRestart?: boolean;
  updatedAt?: string;
  error?: string;
};

type ComponentPackageUpdateRequest = {
  name?: string;
  version?: string;
};

type ComponentPackageUpdateResult = {
  ok: boolean;
  name: string;
  requestedVersion: string | null;
  installed: string | null;
  declared: string | null;
  updatedAt?: string;
  error?: string;
};

export type RuntimeConfigSlice = {
  loxone: { firmwareVersion: string; apiVersion: string };
  http: { publicDir: string };
};

export type MiscHandlerDeps = {
  log: ComponentLogger;
  configPort: ConfigPort;
  groupManager: GroupManagerReadPort;
  snapcastCore: SnapcastCore;
  runtimeConfig: RuntimeConfigSlice;
  onReinitialize?: () => Promise<boolean>;
  onSoftRestart?: () => Promise<boolean>;
  onLoxoneToggle?: (enabled: boolean) => Promise<void>;
  loxoneNotifier?: LoxoneWsNotifier;
  sonnCorePeers: SonnCorePeerRegistry;
  /**
   * Versions the speakers are running, oldest first.
   *
   * Here rather than on its own screen because "something is behind" has one home in this UI: the
   * chip in the shell reads this payload, and a speaker left on an old build is exactly the kind of
   * thing nobody goes looking for.
   */
  sonnClientVersions?: () => string[];
  /** Whether this request carries a valid admin session; see handleInfo. */
  isAuthenticated: (req: IncomingMessage) => boolean;
  readJsonBody: (req: IncomingMessage, res: ServerResponse, maxBytes?: number) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

/** Order two dotted versions oldest-first, so a park's laggard sorts to the front. */
function compareVersions(a: string, b: string): number {
  const parts = (value: string): number[] =>
    value
      .replace(/^v/, '')
      .split(/[.-]/)
      .map((piece) => Number.parseInt(piece, 10))
      .map((piece) => (Number.isFinite(piece) ? piece : 0));
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function buildMiscRoutes(deps: MiscHandlerDeps): Route[] {
  // In-flight gates — captured by handler closures so /adminui/update and
  // /components/update reject overlapping requests with 409.
  let adminUiUpdateInFlight: Promise<AdminUiUpdateResult> | null = null;
  let playerUpdateInFlight: Promise<AdminUiUpdateResult> | null = null;
  let serverUpdateInFlight: Promise<ServerUpdateResult> | null = null;
  let componentPackageUpdateInFlight: Promise<ComponentPackageUpdateResult> | null = null;
  const containerized = detectContainerized();

  return [
    {
      method: 'POST',
      pattern: /^\/snapcast\/clients\/([^/]+)\/stream$/,
      handler: async (req, res, match) => {
        const clientId = decodeURIComponent(match[1] ?? '').trim();
        const body = (await deps.readJsonBody(req, res)) as { streamId?: string } | null;
        if (res.writableEnded) {
          return;
        }
        const streamId = body?.streamId?.trim();
        if (!clientId || !streamId) {
          deps.sendJson(res, 400, { error: 'invalid-snapcast-mapping' });
          return;
        }
        const result = deps.snapcastCore.setClientStream(clientId, streamId);
        deps.sendJson(res, 200, { clientId, streamId, ...result });
      },
    },
    {
      method: 'POST',
      pattern: /^\/setup\/reinitialize$/,
      handler: async (_req, res) => handleReinitialize(res, deps),
    },
    {
      method: 'POST',
      pattern: /^\/setup\/restart$/,
      handler: async (_req, res) => handleSoftRestart(res, deps),
    },
    {
      method: 'POST',
      pattern: /^\/setup\/loxone$/,
      handler: async (req, res) => handleLoxoneToggle(req, res, deps),
    },
    {
      method: 'POST',
      pattern: /^\/adminui\/update$/,
      handler: async (req, res) => {
        if (adminUiUpdateInFlight) {
          deps.sendJson(res, 409, { error: 'adminui-update-in-progress' });
          return;
        }
        const body = (await deps.readJsonBody(req, res)) as AdminUiUpdateRequest | null;
        if (res.writableEnded) {
          return;
        }
        const release = typeof body?.release === 'string' ? body.release.trim() : '';
        const task = performAdminUiUpdate(release || undefined, deps);
        adminUiUpdateInFlight = task;
        try {
          const result = await task;
          if (!result.ok) {
            deps.sendJson(res, 500, result);
            return;
          }
          deps.sendJson(res, 200, result);
        } finally {
          if (adminUiUpdateInFlight === task) {
            adminUiUpdateInFlight = null;
          }
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/player\/update$/,
      handler: async (req, res) => {
        if (playerUpdateInFlight) {
          deps.sendJson(res, 409, { error: 'player-update-in-progress' });
          return;
        }
        const body = (await deps.readJsonBody(req, res)) as AdminUiUpdateRequest | null;
        if (res.writableEnded) {
          return;
        }
        const release = typeof body?.release === 'string' ? body.release.trim() : '';
        const task = performWebBundleUpdate(PLAYER_BUNDLE, release || undefined, deps);
        playerUpdateInFlight = task;
        try {
          const result = await task;
          if (!result.ok) {
            deps.sendJson(res, 500, result);
            return;
          }
          deps.sendJson(res, 200, result);
        } finally {
          if (playerUpdateInFlight === task) {
            playerUpdateInFlight = null;
          }
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/server\/update$/,
      handler: async (req, res) => {
        if (serverUpdateInFlight) {
          deps.sendJson(res, 409, { error: 'server-update-in-progress' });
          return;
        }
        const body = (await deps.readJsonBody(req, res)) as AdminUiUpdateRequest | null;
        if (res.writableEnded) {
          return;
        }
        const release = typeof body?.release === 'string' ? body.release.trim() : '';
        // Containerized deployments are brought back by the restart policy; native
        // installs only auto-restart when a supervisor (systemd/pm2) is signalled.
        const willRestart = containerized || isRestartSupervised();
        const task = performServerUpdate(release || undefined, willRestart, deps);
        serverUpdateInFlight = task;
        try {
          const result = await task;
          if (!result.ok) {
            deps.sendJson(res, 500, result);
            return;
          }
          deps.sendJson(res, 200, result);
          if (result.willRestart) {
            deps.log.info('server update: restarting to apply new code', {});
            scheduleRestart();
          }
        } finally {
          if (serverUpdateInFlight === task) {
            serverUpdateInFlight = null;
          }
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/components\/update$/,
      handler: async (req, res) => {
        if (componentPackageUpdateInFlight) {
          deps.sendJson(res, 409, { error: 'component-update-in-progress' });
          return;
        }
        const body = (await deps.readJsonBody(req, res)) as ComponentPackageUpdateRequest | null;
        if (res.writableEnded) {
          return;
        }
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        const requestedVersionRaw = typeof body?.version === 'string' ? body.version.trim() : '';
        if (!name) {
          deps.sendJson(res, 400, { error: 'component-name-required' });
          return;
        }
        const declaredPackages = readDeclaredAddonPackages();
        if (!Object.prototype.hasOwnProperty.call(declaredPackages, name)) {
          deps.sendJson(res, 400, { error: 'component-not-declared' });
          return;
        }
        if (!name.startsWith(ADDON_PACKAGE_PREFIX)) {
          deps.sendJson(res, 400, { error: 'invalid-component-package' });
          return;
        }
        const requestedVersion = requestedVersionRaw || null;
        if (requestedVersion && !/^[0-9A-Za-z.+_-]+$/.test(requestedVersion)) {
          deps.sendJson(res, 400, { error: 'invalid-component-version' });
          return;
        }
        const task = performComponentPackageUpdate(name, requestedVersion, deps);
        componentPackageUpdateInFlight = task;
        try {
          const result = await task;
          if (!result.ok) {
            deps.sendJson(res, 500, result);
            return;
          }
          deps.sendJson(res, 200, result);
        } finally {
          if (componentPackageUpdateInFlight === task) {
            componentPackageUpdateInFlight = null;
          }
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/info$/,
      handler: (req, res) => handleInfo(req, res, deps, containerized),
    },
    {
      method: 'GET',
      pattern: /^\/updates\/check$/,
      handler: async (req, res) => {
        const force = (() => {
          try {
            return new URL(req.url ?? '', 'http://localhost').searchParams.get('force') === '1';
          } catch {
            return false;
          }
        })();
        try {
          // Caching, coalescing, backoff and stale-on-failure live in the checker.
          deps.sendJson(res, 200, await updateChecker.check(force));
        } catch (err) {
          deps.log.warn('update check failed', { err });
          deps.sendJson(res, 502, { error: 'update-check-failed' });
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/audioservers$/,
      handler: (_req, res) => handleAudioServers(res, deps),
    },
    { method: 'GET', pattern: /^\/logs$/, handler: (_req, res) => handleLogsSnapshot(res, deps) },
    {
      method: 'GET',
      pattern: /^\/logs\/stream$/,
      handler: (req, res) => handleLogsStream(req, res),
    },
    { method: 'GET', pattern: /^\/groups$/, handler: (_req, res) => handleGroups(res, deps) },
    {
      method: 'POST',
      pattern: /^\/logs\/level$/,
      handler: async (req, res) => handleLogLevelUpdate(req, res, deps),
    },
  ];
}

/**
 * Server status. Reachable without a session, because the Admin UI has to know whether
 * to show a login form or a create-admin welcome before it can authenticate — asking
 * an authenticated route would only ever return 401, which cannot distinguish "log in"
 * from "fresh install".
 *
 * That bootstrap needs three flags. Everything else — the serial, the Miniserver's IP
 * and serial, the installed package inventory — is only interesting once you are in,
 * and was readable by anyone on the network for as long as the whole payload was
 * public. So an unauthenticated caller gets the three flags and nothing more.
 */
function handleInfo(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MiscHandlerDeps,
  containerized: boolean,
): void {
  try {
    const cfg = deps.configPort.getConfig();

    // What the Admin UI reads before login, and all it reads.
    const bootstrap = {
      paired: !!cfg.system.audioserver.paired,
      setupComplete: cfg.system.audioserver.setupComplete === true,
      // Drives the admin UI: a create-admin welcome when false, login when true.
      hasAdminUser: hasAdminUser(deps.configPort),
    };

    if (!deps.isAuthenticated(req)) {
      deps.sendJson(res, 200, bootstrap);
      return;
    }

    const pkgVersion = readPackageVersion();
    const buildVersion = readBuildVersion(pkgVersion);
    const packages = readAddonPackageVersions();
    const player = { installed: readPlayerVersion(deps.runtimeConfig.http.publicDir) };
    // The oldest, because that is what "the speakers run X" has to mean when they disagree.
    const runningClients = (deps.sonnClientVersions?.() ?? []).filter(Boolean).sort(compareVersions);
    const sonnClient = { installed: runningClients[0] ?? null };

    const payload = {
      ...bootstrap,
      version: buildVersion,
      // Which artifact this is (dev/testing/beta/stable), so the UI can warn on a
      // build never meant for a real system instead of guessing from the version
      // string. Distinct from the update channel above, which is about which
      // releases this install is offered.
      buildChannel: readBuildChannel(),
      uptime: Math.floor(process.uptime()),
      name: cfg.system.audioserver.name ?? 'Unconfigured',
      serial: cfg.system.audioserver.macId ?? '',
      firmwareVersion: deps.runtimeConfig.loxone.firmwareVersion,
      apiVersion: deps.runtimeConfig.loxone.apiVersion,
      miniserverIp: cfg.system.miniserver.ip ?? '',
      miniserverSerial: cfg.system.miniserver.serial ?? '',
      zones: cfg.zones?.length ?? 0,
      activeAdapters: cfg.system.audioserver.extensions?.length ?? 0,
      loxoneEnabled: cfg.system.audioserver.loxoneEnabled === true,
      packages,
      player,
      sonnClient,
      containerized,
      // Whether a server-core update will auto-restart, so the UI can either
      // promise a reboot or tell the user to restart the service manually.
      restartSupervised: containerized || isRestartSupervised(),
    };

    deps.sendJson(res, 200, payload);
  } catch (err) {
    deps.log.error('failed to produce admin info', { err });
    deps.sendJson(res, 500, { error: 'info-unavailable' });
  }
}

/**
 * Lists every audioserver the Miniserver knows about (see buildAudioServersList). Used by the admin
 * UI to offer a "switch audioserver" control — the browser then re-points at the chosen server's
 * /admin/.
 */
function handleAudioServers(res: ServerResponse, deps: MiscHandlerDeps): void {
  try {
    const { self, servers } = buildAudioServersList(deps.configPort, deps.sonnCorePeers);
    deps.sendJson(res, 200, { self, servers });
  } catch (err) {
    deps.log.warn('audioservers list failed', { err });
    deps.sendJson(res, 500, { error: 'audioservers-unavailable' });
  }
}

async function handleReinitialize(res: ServerResponse, deps: MiscHandlerDeps): Promise<void> {
  if (!deps.onReinitialize) {
    deps.sendJson(res, 501, { error: 'reinitialize-not-supported' });
    return;
  }
  try {
    const ok = await deps.onReinitialize();
    if (!ok) {
      deps.sendJson(res, 500, { error: 'reinitialize-failed' });
      return;
    }
    deps.loxoneNotifier?.notifyRestart();
    deps.sendJson(res, 200, { ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log.error('reinitialize failed', { message });
    deps.sendJson(res, 500, { error: 'reinitialize-error', message });
  }
}

// Full stop+start of the running services, re-reading config so the deployment-mode
// gate is re-evaluated. This is how a mode choice takes effect: picking 'loxone'
// brings the protocol stack up (so a Miniserver can pair), 'standalone' tears it down.
// The restart tears down this very HTTP server, so we answer first and kick the
// restart off on the next tick — the client polls status to learn when it's back.
async function handleSoftRestart(res: ServerResponse, deps: MiscHandlerDeps): Promise<void> {
  if (!deps.onSoftRestart) {
    deps.sendJson(res, 501, { error: 'restart-not-supported' });
    return;
  }
  const onSoftRestart = deps.onSoftRestart;
  deps.sendJson(res, 202, { ok: true, restarting: true });
  setTimeout(() => {
    void onSoftRestart().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      deps.log.error('soft restart failed', { message });
    });
  }, 100);
}

// Connect/disconnect the Loxone integration by starting/stopping just its protocol
// subsystem (command engine + Miniserver/native-app servers + discovery). The rest
// of the server keeps running, so unlike a mode switch there is no restart here.
async function handleLoxoneToggle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MiscHandlerDeps,
): Promise<void> {
  if (!deps.onLoxoneToggle) {
    deps.sendJson(res, 501, { error: 'loxone-toggle-not-supported' });
    return;
  }
  const body = (await deps.readJsonBody(req, res)) as { enabled?: boolean } | null;
  if (res.writableEnded) return;
  if (!body || typeof body.enabled !== 'boolean') {
    deps.sendJson(res, 400, { error: 'invalid-loxone-payload' });
    return;
  }
  try {
    await deps.onLoxoneToggle(body.enabled);
    deps.sendJson(res, 200, { ok: true, loxoneEnabled: body.enabled });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log.error('loxone toggle failed', { message });
    deps.sendJson(res, 500, { error: 'loxone-toggle-error', message });
  }
}

function handleLogsSnapshot(res: ServerResponse, deps: MiscHandlerDeps): void {
  try {
    const snapshot = logBuffer.snapshot();
    const cfg = deps.configPort.getConfig();
    const consoleLevel = cfg.system?.logging?.consoleLevel ?? 'none';
    deps.sendJson(res, 200, { ...snapshot, consoleLevel });
  } catch (err) {
    deps.log.warn('logs snapshot failed', { err });
    deps.sendJson(res, 500, { error: 'logs-fetch-failed' });
  }
}

function handleLogsStream(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  res.write('\n');

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keep-alive\n\n');
    }
  }, 25000);

  const unsubscribe = logBuffer.subscribe((entry) => {
    if (res.writableEnded) {
      return;
    }
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  });

  const cleanup = () => {
    unsubscribe();
    clearInterval(heartbeat);
    if (!res.writableEnded) {
      res.end();
    }
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
}

async function handleLogLevelUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MiscHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as { level?: string } | null;
  if (res.writableEnded) {
    return;
  }
  const level = parseLogLevel(body?.level);
  if (!level) {
    deps.sendJson(res, 400, { error: 'invalid-log-level' });
    return;
  }
  try {
    await deps.configPort.updateConfig((cfg) => {
      if (!cfg.system) {
        cfg.system = defaultConfig().system;
      }
      if (!cfg.system.logging) {
        cfg.system.logging = { consoleLevel: level, fileLevel: 'none' };
      } else {
        cfg.system.logging.consoleLevel = level;
      }
    });
    logManager.configure({ level });
    deps.sendJson(res, 204, {});
  } catch (err) {
    deps.log.warn('log level update failed', { err });
    deps.sendJson(res, 500, { error: 'log-level-update-failed' });
  }
}

function parseLogLevel(value: unknown): LogLevel | null {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  switch (normalized) {
    case 'spam':
    case 'debug':
    case 'info':
    case 'warn':
    case 'error':
    case 'none':
      return normalized as LogLevel;
    default:
      return null;
  }
}

function handleGroups(res: ServerResponse, deps: MiscHandlerDeps): void {
  try {
    const cfg = deps.configPort.getConfig();
    const zoneNameMap = new Map<number, string>();
    (cfg.zones ?? []).forEach((zone) => {
      zoneNameMap.set(zone.id, zone.name);
    });
    const groups = deps.groupManager.getAllGroups().map((group) => ({
      leader: group.leader,
      leaderName: zoneNameMap.get(group.leader) ?? `Zone ${group.leader}`,
      members: group.members,
      memberNames: group.members.map((id) => zoneNameMap.get(id) ?? `Zone ${id}`),
      backend: group.backend,
      externalId: group.externalId ?? null,
      source: group.source,
      updatedAt: group.updatedAt,
    }));
    deps.sendJson(res, 200, { groups });
  } catch (err) {
    deps.log.warn('group fetch failed', { err });
    deps.sendJson(res, 500, { error: 'groups-fetch-failed' });
  }
}

// ---- Info helpers ----


function readAddonPackageVersions(): Record<string, { installed: string | null; declared: string | null }> {
  const declared = readDeclaredAddonPackages();
  const result: Record<string, { installed: string | null; declared: string | null }> = {};
  for (const [name, declaredRange] of Object.entries(declared)) {
    result[name] = {
      declared: declaredRange ?? null,
      installed: readInstalledPackageVersion(name),
    };
  }
  return result;
}

function readDeclaredAddonPackages(): Record<string, string> {
  try {
    const json = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');
    const parsed = JSON.parse(json) as { dependencies?: Record<string, string> };
    const deps = parsed.dependencies ?? {};
    const result: Record<string, string> = {};
    for (const [name, range] of Object.entries(deps)) {
      if (!name.startsWith(ADDON_PACKAGE_PREFIX)) continue;
      if (typeof range !== 'string') continue;
      result[name] = range;
    }
    return result;
  } catch {
    return {};
  }
}

/** Reads the Player bundle's installed version from the version.json emitted
 *  into public/player by the player build. Returns null when the player has
 *  not been fetched/built yet or the manifest predates versioning. */
function readPlayerVersion(publicDir: string): string | null {
  try {
    const json = readFileSync(join(publicDir, 'player', 'version.json'), 'utf8');
    const parsed = JSON.parse(json) as { version?: string };
    return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

function readInstalledPackageVersion(name: string): string | null {
  try {
    const parts = name.split('/').filter(Boolean);
    const pkgJsonPath = resolve(process.cwd(), 'node_modules', ...parts, 'package.json');
    const json = readFileSync(pkgJsonPath, 'utf8');
    const parsed = JSON.parse(json) as { version?: string };
    return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

function detectContainerized(): boolean {
  const forced = (process.env.LOX_DEPLOYMENT ?? '').trim().toLowerCase();
  if (forced === 'docker' || forced === 'container') return true;
  if (forced === 'git' || forced === 'host' || forced === 'standalone') return false;

  if (existsSync('/.dockerenv')) return true;

  try {
    const cgroup = readFileSync('/proc/1/cgroup', 'utf8');
    return /(docker|containerd|kubepods|podman|lxc)/i.test(cgroup);
  } catch {
    return false;
  }
}

// ---- Update helpers ----

/** Static descriptor for a downloadable web bundle that the AudioServer serves
 *  from its public dir and can update in-place (atomic swap + rollback). */
type WebBundleSpec = {
  /** Human label used in log lines, e.g. "admin ui" / "player". */
  label: string;
  repo: string;
  assetName: string;
  /** Sub-directory under publicDir that holds the served bundle. */
  publicSubdir: string;
  /** Prefix for the temp staging/backup dirs + archive file. */
  workPrefix: string;
  /** Optional env overrides for the release tag and full dist URL. */
  releaseEnv?: string;
  distUrlEnv?: string;
};

const ADMINUI_BUNDLE: WebBundleSpec = {
  label: 'admin ui',
  repo: 'sonn-audio/adminui',
  assetName: 'admin-dist.tgz',
  publicSubdir: 'admin',
  workPrefix: 'admin',
  releaseEnv: 'ADMINUI_RELEASE',
  distUrlEnv: 'ADMINUI_DIST_URL',
};

const PLAYER_BUNDLE: WebBundleSpec = {
  label: 'player',
  repo: 'sonn-audio/player',
  assetName: 'player-dist.tgz',
  publicSubdir: 'player',
  workPrefix: 'player',
  releaseEnv: 'PLAYER_RELEASE',
  distUrlEnv: 'PLAYER_DIST_URL',
};

async function performAdminUiUpdate(
  releaseOverride: string | undefined,
  deps: MiscHandlerDeps,
): Promise<AdminUiUpdateResult> {
  return performWebBundleUpdate(ADMINUI_BUNDLE, releaseOverride, deps);
}

async function performWebBundleUpdate(
  spec: WebBundleSpec,
  releaseOverride: string | undefined,
  deps: MiscHandlerDeps,
): Promise<AdminUiUpdateResult> {
  const release =
    releaseOverride || (spec.releaseEnv ? process.env[spec.releaseEnv] : undefined) || 'latest';
  const distUrl =
    (spec.distUrlEnv ? process.env[spec.distUrlEnv] : undefined) ??
    (release === 'latest'
      ? `https://github.com/${spec.repo}/releases/latest/download/${spec.assetName}`
      : `https://github.com/${spec.repo}/releases/download/${encodeURIComponent(release)}/${spec.assetName}`);
  const targetDir = join(deps.runtimeConfig.http.publicDir, spec.publicSubdir);
  const stagingDir = join(deps.runtimeConfig.http.publicDir, `${spec.workPrefix}-staging-${Date.now()}`);
  const backupDir = join(deps.runtimeConfig.http.publicDir, `${spec.workPrefix}-backup-${Date.now()}`);
  const archivePath = join(os.tmpdir(), `${spec.workPrefix}-dist-${Date.now()}.tgz`);

  deps.log.info(`${spec.label} update started`, { release, distUrl, targetDir });

  const baseResult = { release, distUrl, targetDir };
  let backupCreated = false;

  try {
    try {
      await fs.rm(archivePath, { force: true });
    } catch {
      // Best-effort cleanup.
    }
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.mkdir(stagingDir, { recursive: true });

    await downloadBundle(distUrl, archivePath);
    await extractBundle(archivePath, stagingDir);
    try {
      await fs.rm(archivePath, { force: true });
    } catch {
      // Best-effort cleanup.
    }

    if (await pathExists(targetDir)) {
      await fs.rm(backupDir, { recursive: true, force: true });
      await moveDir(targetDir, backupDir);
      backupCreated = true;
    }
    await moveDir(stagingDir, targetDir);
    if (backupCreated) {
      try {
        await fs.rm(backupDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        const cleanupMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        deps.log.warn(`${spec.label} cleanup failed`, { cleanupMessage });
      }
    }

    deps.log.info(`${spec.label} update finished`, { release, distUrl });
    return { ok: true, updatedAt: new Date().toISOString(), ...baseResult };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log.warn(`${spec.label} update failed`, { release, distUrl, message });

    try {
      if (await pathExists(stagingDir)) {
        await fs.rm(stagingDir, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup.
    }

    try {
      await fs.rm(archivePath, { force: true });
    } catch {
      // Best-effort cleanup.
    }

    if (backupCreated) {
      try {
        await fs.rm(targetDir, { recursive: true, force: true });
        await moveDir(backupDir, targetDir);
      } catch (rollbackErr) {
        const rollbackMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        deps.log.warn(`${spec.label} rollback failed`, { rollbackMessage });
      }
    }

    return { ok: false, error: message, ...baseResult };
  }
}

const SERVER_REPO = 'sonn-audio/core';
const SERVER_ASSET = 'server-dist.tgz';
const SERVER_MANIFESTS = ['package.json', 'package-lock.json'] as const;

/** True when a native (non-container) deployment runs under a supervisor that
 *  restarts the process on exit (systemd `Restart=`, pm2, …). Set explicitly so
 *  we never kill a bare `npm start` that would not come back. */
function isRestartSupervised(): boolean {
  const v = (process.env.LOX_RESTART_SUPERVISED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Exit shortly after the response has flushed so the supervisor/restart policy
 *  starts a fresh process against the freshly-swapped dist. */
function scheduleRestart(): void {
  setTimeout(() => process.exit(0), 500).unref();
}

function fileSha256(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

type ReleaseChannel = 'stable' | 'beta';
type ResolvedRelease = { release: string; distUrl: string; channel: ReleaseChannel | 'pinned' };

/** Determines the release channel from the running version: a SemVer prerelease
 *  suffix (e.g. `4.0.0-beta.15`) means the beta channel. Override with
 *  SERVER_RELEASE_CHANNEL. Mirrors the Docker `:latest` vs `:beta` tag split. */
function detectReleaseChannel(): ReleaseChannel {
  const forced = (process.env.SERVER_RELEASE_CHANNEL ?? '').trim().toLowerCase();
  if (forced === 'beta' || forced === 'prerelease') return 'beta';
  if (forced === 'stable' || forced === 'latest') return 'stable';
  return readPackageVersion().includes('-') ? 'beta' : 'stable';
}

/** Newest prerelease tag that actually carries a server-dist asset — older betas
 *  predating this feature are skipped so we never resolve to a 404. */
async function fetchLatestPrereleaseTag(): Promise<string | null> {
  const data = await fetchUpstreamJson(
    `https://api.github.com/repos/${SERVER_REPO}/releases?per_page=30`,
  );
  if (!Array.isArray(data)) return null;
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const rel = entry as {
      tag_name?: string;
      prerelease?: boolean;
      draft?: boolean;
      assets?: Array<{ name?: string }>;
    };
    if (rel.draft || !rel.prerelease) continue;
    if (!Array.isArray(rel.assets) || !rel.assets.some((a) => a?.name === SERVER_ASSET)) continue;
    const tag = typeof rel.tag_name === 'string' ? rel.tag_name.trim() : '';
    if (tag) return tag;
  }
  return null;
}

/**
 * Resolves which release the server should update to. An explicit tag or a
 * SERVER_DIST_URL override is honoured verbatim ('pinned'). Otherwise the
 * channel is derived from the running version: stable uses the fast static
 * `releases/latest` URL; beta queries the releases API for the newest
 * prerelease, since `releases/latest` never resolves to a prerelease.
 */
async function resolveServerRelease(releaseOverride: string | undefined): Promise<ResolvedRelease> {
  const urlOverride = process.env.SERVER_DIST_URL?.trim();
  const explicit = (releaseOverride ?? process.env.SERVER_RELEASE ?? '').trim();

  if (explicit && explicit !== 'latest') {
    return {
      release: explicit,
      distUrl:
        urlOverride ||
        `https://github.com/${SERVER_REPO}/releases/download/${encodeURIComponent(explicit)}/${SERVER_ASSET}`,
      channel: 'pinned',
    };
  }
  if (urlOverride) {
    return { release: explicit || 'latest', distUrl: urlOverride, channel: 'pinned' };
  }

  const channel = detectReleaseChannel();
  if (channel === 'stable') {
    return {
      release: 'latest',
      distUrl: `https://github.com/${SERVER_REPO}/releases/latest/download/${SERVER_ASSET}`,
      channel,
    };
  }

  const tag = await fetchLatestPrereleaseTag();
  if (!tag) {
    throw new Error('no beta release with a server-dist asset found');
  }
  return {
    release: tag,
    distUrl: `https://github.com/${SERVER_REPO}/releases/download/${encodeURIComponent(tag)}/${SERVER_ASSET}`,
    channel,
  };
}

/**
 * Updates the server core in place: downloads server-dist.tgz (dist/ + manifests),
 * atomically swaps dist/, overwrites the package manifests, and — only when the
 * lockfile changed — runs `npm ci --omit=dev` to resync node_modules. On any
 * failure it rolls dist/ and the manifests back. The running process keeps its
 * in-memory code; the new code only loads after the restart signalled by the
 * caller. Mirrors the web-bundle swap (performWebBundleUpdate) but placement
 * differs: the tarball carries files at two levels (dist/ + root manifests), so
 * it gets its own orchestration rather than the generic whole-dir move.
 */
async function performServerUpdate(
  releaseOverride: string | undefined,
  willRestart: boolean,
  deps: MiscHandlerDeps,
): Promise<ServerUpdateResult> {
  const root = process.cwd();
  const targetDir = join(root, 'dist');
  const stagingDir = join(root, `server-staging-${Date.now()}`);
  const backupDir = join(root, `server-backup-${Date.now()}`);
  const manifestBackup = join(root, `server-manifest-backup-${Date.now()}`);
  const archivePath = join(os.tmpdir(), `server-dist-${Date.now()}.tgz`);

  // Resolved inside the try so a failed channel lookup yields a clean error result.
  let release = (releaseOverride ?? process.env.SERVER_RELEASE ?? 'latest').trim() || 'latest';
  let distUrl = '';
  let distBackupCreated = false;
  let manifestBackupCreated = false;

  // Capture the deployed lockfile hash before anything is overwritten, so we can
  // tell afterwards whether dependencies actually changed.
  const prevLockHash = fileSha256(join(root, 'package-lock.json'));

  try {
    const resolved = await resolveServerRelease(releaseOverride);
    release = resolved.release;
    distUrl = resolved.distUrl;
    deps.log.info('server update started', { release, distUrl, channel: resolved.channel, targetDir });

    await fs.rm(archivePath, { force: true }).catch(() => {});
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.mkdir(stagingDir, { recursive: true });

    await downloadBundle(distUrl, archivePath);
    await extractBundle(archivePath, stagingDir);
    await fs.rm(archivePath, { force: true }).catch(() => {});

    const stagedDist = join(stagingDir, 'dist');
    if (!(await pathExists(stagedDist))) {
      throw new Error('server bundle missing dist/ directory');
    }

    // 1. Atomic dist swap with backup.
    if (await pathExists(targetDir)) {
      await fs.rm(backupDir, { recursive: true, force: true });
      await moveDir(targetDir, backupDir);
      distBackupCreated = true;
    }
    await moveDir(stagedDist, targetDir);

    // 2. Overwrite the package manifests, backing up the current ones first.
    await fs.mkdir(manifestBackup, { recursive: true });
    for (const file of SERVER_MANIFESTS) {
      const staged = join(stagingDir, file);
      if (!(await pathExists(staged))) continue;
      const current = join(root, file);
      if (await pathExists(current)) {
        await fs.cp(current, join(manifestBackup, file));
        manifestBackupCreated = true;
      }
      await fs.cp(staged, current);
    }

    // 3. Resync node_modules only when the lockfile actually changed.
    const newLockHash = fileSha256(join(root, 'package-lock.json'));
    const depsChanged = !!newLockHash && newLockHash !== prevLockHash;
    if (depsChanged) {
      deps.log.info('server update: lockfile changed, running npm ci', {});
      const { code, stderr } = await spawnForCompletion(
        'npm',
        ['ci', '--omit=dev', '--no-audit', '--no-fund'],
        root,
      );
      if (code !== 0) {
        throw new Error(stderr.trim() || `npm ci exited with code ${code}`);
      }
    }

    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    if (distBackupCreated) {
      await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
    }
    if (manifestBackupCreated) {
      await fs.rm(manifestBackup, { recursive: true, force: true }).catch(() => {});
    }

    deps.log.info('server update finished', { release, depsChanged, willRestart });
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      depsChanged,
      restartRequired: true,
      willRestart,
      release,
      distUrl,
      targetDir,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log.warn('server update failed', { release, distUrl, message });

    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(archivePath, { force: true }).catch(() => {});

    if (distBackupCreated) {
      try {
        await fs.rm(targetDir, { recursive: true, force: true });
        await moveDir(backupDir, targetDir);
      } catch (rollbackErr) {
        const rollbackMessage =
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        deps.log.warn('server dist rollback failed', { rollbackMessage });
      }
    }
    if (manifestBackupCreated) {
      try {
        for (const file of SERVER_MANIFESTS) {
          const bak = join(manifestBackup, file);
          if (await pathExists(bak)) await fs.cp(bak, join(root, file));
        }
        await fs.rm(manifestBackup, { recursive: true, force: true });
      } catch (rollbackErr) {
        const rollbackMessage =
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        deps.log.warn('server manifest rollback failed', { rollbackMessage });
      }
    }

    return {
      ok: false,
      error: message,
      restartRequired: false,
      willRestart: false,
      release,
      distUrl,
      targetDir,
    };
  }
}

async function performComponentPackageUpdate(
  name: string,
  requestedVersion: string | null,
  deps: MiscHandlerDeps,
): Promise<ComponentPackageUpdateResult> {
  const packageSpec = requestedVersion ? `${name}@${requestedVersion}` : `${name}@latest`;
  deps.log.info('component update started', { packageSpec });

  try {
    const { code, stderr } = await spawnForCompletion(
      'npm',
      ['install', packageSpec, '--no-audit', '--no-fund'],
      process.cwd(),
    );
    if (code !== 0) {
      const message = stderr.trim() || `npm exited with code ${code}`;
      deps.log.warn('component update failed', { packageSpec, message });
      return {
        ok: false,
        name,
        requestedVersion,
        installed: readInstalledPackageVersion(name),
        declared: readDeclaredAddonPackages()[name] ?? null,
        error: message,
      };
    }

    const installed = readInstalledPackageVersion(name);
    const declared = readDeclaredAddonPackages()[name] ?? null;
    deps.log.info('component update finished', { packageSpec, installed, declared });
    return {
      ok: true,
      name,
      requestedVersion,
      installed,
      declared,
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log.warn('component update failed', { packageSpec, message });
    return {
      ok: false,
      name,
      requestedVersion,
      installed: readInstalledPackageVersion(name),
      declared: readDeclaredAddonPackages()[name] ?? null,
      error: message,
    };
  }
}

async function downloadBundle(url: string, dest: string, redirects = 0): Promise<void> {
  if (redirects > 5) {
    throw new Error(`Too many redirects while downloading ${url}`);
  }

  await new Promise<void>((resolveOuter, rejectOuter) => {
    const request = https.get(
      url,
      { headers: { 'User-Agent': 'sonn-core-bundle-fetch' } },
      (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.resume();
          resolveOuter(downloadBundle(response.headers.location, dest, redirects + 1));
          return;
        }

        if (status !== 200) {
          response.resume();
          rejectOuter(new Error(`Failed to download bundle (${status}) from ${url}`));
          return;
        }

        pipeline(response, createWriteStream(dest)).then(resolveOuter).catch(rejectOuter);
      },
    );

    request.on('error', rejectOuter);
  });
}

async function moveDir(sourceDir: string, targetDir: string): Promise<void> {
  try {
    await fs.rename(sourceDir, targetDir);
    return;
  } catch (err) {
    if (!isCrossDeviceRenameError(err)) {
      throw err;
    }
  }

  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.cp(sourceDir, targetDir, { recursive: true });
  await fs.rm(sourceDir, { recursive: true, force: true });
}

async function extractBundle(archive: string, dest: string): Promise<void> {
  await new Promise<void>((resolveOuter, rejectOuter) => {
    const proc = spawn('tar', ['-xzf', archive, '-C', dest], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    if (proc.stderr) {
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }

    proc.on('close', (code) => {
      if (code === 0) {
        resolveOuter();
      } else {
        const suffix = stderr.trim() ? `: ${stderr.trim()}` : '';
        rejectOuter(new Error(`tar exited with code ${code}${suffix}`));
      }
    });
    proc.on('error', rejectOuter);
  });
}

async function spawnForCompletion(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveOuter, rejectOuter) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    if (proc.stdout) {
      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
    }
    if (proc.stderr) {
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }

    proc.on('close', (code) => {
      resolveOuter({ code: code ?? 1, stdout, stderr });
    });
    proc.on('error', rejectOuter);
  });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isCrossDeviceRenameError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'EXDEV'
  );
}
