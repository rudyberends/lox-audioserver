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
      containerized,
    };

    deps.sendJson(res, 200, payload);
  } catch (err) {
    deps.log.error('failed to produce admin info', { err });
    deps.sendJson(res, 500, { error: 'info-unavailable' });
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

async function performAdminUiUpdate(
  releaseOverride: string | undefined,
  deps: MiscHandlerDeps,
): Promise<AdminUiUpdateResult> {
  const repo = 'lox-audioserver/adminui';
  const assetName = 'admin-dist.tgz';
  const release = releaseOverride || process.env.ADMINUI_RELEASE || 'latest';
  const distUrl =
    process.env.ADMINUI_DIST_URL ??
    (release === 'latest'
      ? `https://github.com/${repo}/releases/latest/download/${assetName}`
      : `https://github.com/${repo}/releases/download/${encodeURIComponent(release)}/${assetName}`);
  const targetDir = join(deps.runtimeConfig.http.publicDir, 'admin');
  const stagingDir = join(deps.runtimeConfig.http.publicDir, `admin-staging-${Date.now()}`);
  const backupDir = join(deps.runtimeConfig.http.publicDir, `admin-backup-${Date.now()}`);
  const archivePath = join(os.tmpdir(), `admin-dist-${Date.now()}.tgz`);

  deps.log.info('admin ui update started', { release, distUrl, targetDir });

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

    await downloadAdminUi(distUrl, archivePath);
    await extractAdminUi(archivePath, stagingDir);
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
        deps.log.warn('admin ui cleanup failed', { cleanupMessage });
      }
    }

    deps.log.info('admin ui update finished', { release, distUrl });
    return { ok: true, updatedAt: new Date().toISOString(), ...baseResult };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log.warn('admin ui update failed', { release, distUrl, message });

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
        deps.log.warn('admin ui rollback failed', { rollbackMessage });
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

async function downloadAdminUi(url: string, dest: string, redirects = 0): Promise<void> {
  if (redirects > 5) {
    throw new Error(`Too many redirects while downloading ${url}`);
  }

  await new Promise<void>((resolveOuter, rejectOuter) => {
    const request = https.get(
      url,
      { headers: { 'User-Agent': 'lox-audioserver-admin-fetch' } },
      (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.resume();
          resolveOuter(downloadAdminUi(response.headers.location, dest, redirects + 1));
          return;
        }

        if (status !== 200) {
          response.resume();
          rejectOuter(new Error(`Failed to download admin dist (${status}) from ${url}`));
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

async function extractAdminUi(archive: string, dest: string): Promise<void> {
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
