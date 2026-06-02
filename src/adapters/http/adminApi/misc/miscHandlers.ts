import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { createWriteStream, promises as fs, existsSync, readFileSync } from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ComponentLogger } from '@/shared/logging/logger';
import { logManager } from '@/shared/logging/logger';
import { logBuffer } from '@/shared/logging/logBuffer';
import type { LogLevel } from '@/types/logLevel';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { GroupManagerReadPort } from '@/application/groups/groupManager';
import type { SnapcastCore } from '@/adapters/outputs/snapcast/snapcastCore';
import type { Route } from '@/adapters/http/adminApi/routeTypes';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import { defaultConfig } from '@/adapters/http/adminApi/config/configHandlers';

const ADDON_PACKAGE_PREFIX = '@lox-audioserver/node-';

type AdminUiUpdateRequest = { release?: string };

type AdminUiUpdateResult = {
  ok: boolean;
  release: string;
  distUrl: string;
  targetDir: string;
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
  loxoneNotifier?: LoxoneWsNotifier;
  readJsonBody: (req: IncomingMessage, res: ServerResponse, maxBytes?: number) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

export function buildMiscRoutes(deps: MiscHandlerDeps): Route[] {
  // In-flight gates — captured by handler closures so /adminui/update and
  // /components/update reject overlapping requests with 409.
  let adminUiUpdateInFlight: Promise<AdminUiUpdateResult> | null = null;
  let playerUpdateInFlight: Promise<AdminUiUpdateResult> | null = null;
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
      handler: (_req, res) => handleInfo(res, deps, containerized),
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

function handleInfo(res: ServerResponse, deps: MiscHandlerDeps, containerized: boolean): void {
  try {
    const cfg = deps.configPort.getConfig();
    const pkgVersion = readPackageVersion();
    const buildVersion = readBuildVersion(pkgVersion);
    const packages = readAddonPackageVersions();
    const player = { installed: readPlayerVersion(deps.runtimeConfig.http.publicDir) };

    const payload = {
      version: buildVersion,
      uptime: Math.floor(process.uptime()),
      name: cfg.system.audioserver.name ?? 'Unconfigured',
      serial: cfg.system.audioserver.macId ?? '',
      firmwareVersion: deps.runtimeConfig.loxone.firmwareVersion,
      apiVersion: deps.runtimeConfig.loxone.apiVersion,
      miniserverIp: cfg.system.miniserver.ip ?? '',
      miniserverSerial: cfg.system.miniserver.serial ?? '',
      zones: cfg.zones?.length ?? 0,
      activeAdapters: cfg.system.audioserver.extensions?.length ?? 0,
      paired: !!cfg.system.audioserver.paired,
      authEnabled: cfg.system.audioserver.authEnabled !== false,
      packages,
      player,
      containerized,
    };

    deps.sendJson(res, 200, payload);
  } catch (err) {
    deps.log.error('failed to produce admin info', { err });
    deps.sendJson(res, 500, { error: 'info-unavailable' });
  }
}

type AudioServerEntry = {
  macId: string;
  name: string | null;
  host: string | null;
  ip: string | null;
  port: number | null;
  uuid: string | null;
  master: string | null;
  isSelf: boolean;
};

/**
 * Lists every audioserver the Miniserver knows about, parsed from rawAudioConfig.raw (an array of
 * objects keyed by MAC). The Miniserver pushes the whole site's config to each server, so this
 * includes peers, not just self. Used by the admin UI to offer a "switch audioserver" control —
 * the browser then re-points at the chosen server's /admin/ (each runs its own UI on the HTTP port).
 */
function handleAudioServers(res: ServerResponse, deps: MiscHandlerDeps): void {
  try {
    const cfg = deps.configPort.getConfig();
    const selfMacId = cfg.system?.audioserver?.macId?.trim().toUpperCase() ?? null;
    const servers = parseAudioServers(cfg.rawAudioConfig?.raw ?? cfg.rawAudioConfig?.rawString, selfMacId);
    deps.sendJson(res, 200, { self: selfMacId, servers });
  } catch (err) {
    deps.log.warn('audioservers list failed', { err });
    deps.sendJson(res, 500, { error: 'audioservers-unavailable' });
  }
}

/** Parses rawAudioConfig.raw (array of single-key {<MAC>: section} objects) into a flat list. */
function parseAudioServers(raw: unknown, selfMacId: string | null): AudioServerEntry[] {
  let parsed = raw;
  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    if (!trimmed) return [];
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];

  const servers: AudioServerEntry[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const macId = key.trim().toUpperCase();
      if (!macId) continue;
      const section = value as Record<string, unknown>;
      servers.push({
        macId,
        name: normalizeString(section.name) ?? null,
        host: normalizeString(section.host) ?? null,
        ip: normalizeString(section.ip) ?? null,
        port: typeof section.port === 'number' ? section.port : Number(section.port) || null,
        uuid: normalizeString(section.uuid) ?? null,
        master: normalizeString(section.master)?.toUpperCase() ?? null,
        isSelf: selfMacId != null && macId === selfMacId,
      });
    }
  }
  return servers;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
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

function readPackageVersion(): string {
  try {
    const json = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');
    const parsed = JSON.parse(json) as { version?: string };
    return parsed.version ?? 'dev';
  } catch {
    return 'dev';
  }
}

function readBuildVersion(pkgVersion: string): string {
  const tsRaw = process.env.BUILD_TIMESTAMP?.trim();
  if (!tsRaw) {
    return pkgVersion;
  }
  const normalizedTs = tsRaw.replace(/[^0-9A-Za-z._-]/g, '');
  if (!normalizedTs) {
    return pkgVersion;
  }
  return `${pkgVersion}+${normalizedTs}`;
}

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
  repo: 'lox-audioserver/adminui',
  assetName: 'admin-dist.tgz',
  publicSubdir: 'admin',
  workPrefix: 'admin',
  releaseEnv: 'ADMINUI_RELEASE',
  distUrlEnv: 'ADMINUI_DIST_URL',
};

const PLAYER_BUNDLE: WebBundleSpec = {
  label: 'player',
  repo: 'lox-audioserver/player',
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
      { headers: { 'User-Agent': 'lox-audioserver-bundle-fetch' } },
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
