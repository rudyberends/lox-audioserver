import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@/shared/logging/logger';
import { bestEffort } from '@/shared/bestEffort';
import { ensureDir, readJson, resolveDataDir, writeJson } from '@/shared/utils/file';

export interface StorageConfig {
  id: string;
  name: string;
  server: string;
  folder: string;
  type: string;
  username?: string;
  password?: string;
  guest?: boolean;
  options?: string;
}

interface StorageFilePayload {
  storages: StorageConfig[];
}

const log = createLogger('Content', 'Storage');
const execFileAsync = promisify(execFile);
const STORAGE_PATH = resolveDataDir('music', 'nas', 'storage.json');
const LEGACY_STORAGE_PATH = resolveDataDir('storage', 'storages.json');
const NAS_DIR_TIMEOUT_MS = 3000;
const NAS_MOUNT_TIMEOUT_MS = 8000;
const NAS_CHECK_TIMEOUT_MS = 4000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function loadStorageFile(): Promise<StorageFilePayload> {
  await ensureDir(path.dirname(STORAGE_PATH));
  await ensureDir(path.dirname(LEGACY_STORAGE_PATH));

  const primary = await readJson<StorageFilePayload>(STORAGE_PATH);
  if (primary?.storages) {
    return { storages: primary.storages };
  }

  const legacy = await readJson<StorageFilePayload>(LEGACY_STORAGE_PATH);
  if (legacy?.storages) {
    return { storages: legacy.storages };
  }

  return { storages: [] };
}

async function saveStorageFile(storages: StorageConfig[]): Promise<void> {
  await ensureDir(path.dirname(STORAGE_PATH));
  await ensureDir(path.dirname(LEGACY_STORAGE_PATH));
  await writeJson(STORAGE_PATH, { storages });
  // Best-effort legacy write for compatibility; failure only skips the legacy copy.
  await bestEffort(() => writeJson(LEGACY_STORAGE_PATH, { storages }), {
    fallback: undefined,
    onError: 'debug',
    log,
    label: 'legacy storage save failed',
  });
}

export function getStorageMountPath(id: string): string {
  return path.join(resolveDataDir('music', 'nas'), String(id));
}

async function mountStorage(cfg: StorageConfig, dir: string): Promise<void> {
  if (cfg.type.toLowerCase() !== 'cifs') {
    throw new Error(`Unsupported storage type "${cfg.type}" (only "cifs" is supported)`);
  }

  const unc = `//${cfg.server}/${cfg.folder}`;
  const options: string[] = ['rw', 'file_mode=0644', 'dir_mode=0755', 'iocharset=utf8'];
  const inlineCreds: string[] = [];
  let credentialsPath: string | undefined;

  if (cfg.guest) {
    options.push('guest');
  } else if (cfg.username) {
    if (cfg.password && cfg.password.trim()) {
      credentialsPath = path.join(dir, '.cifs-credentials');
      const credsPath = credentialsPath;
      const content = `username=${cfg.username}\npassword=${cfg.password}\n`;
      // Best-effort credentials file; mount will fall back to inline creds or fail later.
      await bestEffort(
        () => fsp.writeFile(credsPath, content, { encoding: 'utf8', mode: 0o600 }),
        {
          fallback: undefined,
          onError: 'debug',
          log,
          label: 'credentials file write failed',
          context: { dir },
        },
      );
      await bestEffort(() => fsp.chmod(credsPath, 0o600), {
        fallback: undefined,
        onError: 'debug',
        log,
        label: 'credentials chmod failed',
        context: { dir },
      });
      options.push(`credentials=${credsPath}`);
    } else {
      options.push(`username=${cfg.username}`);
    }
    inlineCreds.push(`username=${cfg.username}`);
    if (cfg.password && cfg.password.trim()) {
      inlineCreds.push(`password=${cfg.password}`);
    }
  }

  if (cfg.options && cfg.options.trim()) {
    options.push(
      ...cfg.options
        .split(',')
        .map((opt) => opt.trim())
        .filter(Boolean),
    );
  }

  const attemptMount = async (opts: string[]): Promise<void> => {
    const optString = opts.join(',');
    const mountArgs = ['-t', 'cifs', unc, dir, '-o', optString];
    log.debug('mounting storage', { unc, dir, options: optString });
    await execFileAsync('mount', mountArgs, { timeout: NAS_MOUNT_TIMEOUT_MS });
  };

  const tryMountWithFallback = async (opts: string[]): Promise<void> => {
    try {
      await attemptMount(opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/read-only/i.test(msg)) {
        const roOptions = opts.map((opt) => (opt === 'rw' ? 'ro' : opt));
        await attemptMount(roOptions);
        return;
      }
      throw err;
    }
  };

  try {
    await tryMountWithFallback(options);
    return;
  } catch (primaryErr) {
    // If credentials file was used, try inline username/password as a fallback (matches simple CLI mount).
    if (inlineCreds.length) {
      const inlineOptions = ['rw', 'file_mode=0644', 'dir_mode=0755', 'iocharset=utf8', ...inlineCreds];
      try {
        await tryMountWithFallback(inlineOptions);
        return;
      } catch (inlineErr) {
        if (credentialsPath) {
          // Best-effort cleanup; a missing credentials file is harmless.
          await bestEffort(() => fsp.rm(credentialsPath, { force: true }), {
            fallback: undefined,
            onError: 'debug',
            log,
            label: 'credentials cleanup failed',
            context: { dir },
          });
        }
        const msg = inlineErr instanceof Error ? inlineErr.message : String(inlineErr);
        log.error('mount failed (inline fallback)', { unc, dir, message: msg });
        throw new Error(`mount.cifs failed: ${msg}`);
      }
    }

    if (credentialsPath) {
      // Best-effort cleanup; missing credentials file is harmless.
      await bestEffort(() => fsp.rm(credentialsPath, { force: true }), {
        fallback: undefined,
        onError: 'debug',
        log,
        label: 'credentials cleanup failed',
        context: { dir },
      });
    }
    const msg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    log.error('mount failed', { unc, dir, message: msg });
    throw new Error(`mount.cifs failed: ${msg}`);
  }
}

async function checkMount(dir: string): Promise<boolean> {
  // Best-effort check; if mount output can't be read, treat as not mounted.
  return bestEffort(
    async () => {
      const { stdout } = await execFileAsync('mount', [], { timeout: NAS_CHECK_TIMEOUT_MS });
      const output = typeof stdout === 'string' ? stdout : String(stdout ?? '');
      return output.includes(` ${dir} `);
    },
    {
      fallback: false,
      onError: 'debug',
      log,
      label: 'mount check failed',
      context: { dir },
    },
  );
}

export async function listStorages(): Promise<StorageConfig[]> {
  const file = await loadStorageFile();
  return file.storages;
}

export async function addStorage(
  config: Omit<StorageConfig, 'id'> & { id?: string },
): Promise<StorageConfig> {
  const file = await loadStorageFile();
  const id = config.id ?? `storage-${Date.now()}`;
  const storage: StorageConfig = { ...config, id };

  const mountPoint = getStorageMountPath(storage.id);
  await ensureDir(mountPoint);

  try {
    await mountStorage(storage, mountPoint);
  } catch (err) {
    // Best-effort cleanup; mount failure should not crash cleanup.
    await bestEffort(() => fsp.rm(mountPoint, { recursive: true, force: true }), {
      fallback: undefined,
      onError: 'debug',
      log,
      label: 'mount point cleanup failed',
      context: { mountPoint },
    });
    throw err;
  }

  const updated = [...file.storages, storage];
  await saveStorageFile(updated);
  log.info('mounted storage', { id: storage.id, name: storage.name, mountPoint });
  return storage;
}

export async function deleteStorage(id: string): Promise<void> {
  const file = await loadStorageFile();
  const idx = file.storages.findIndex((storage) => storage.id === id);
  if (idx === -1) {
    return;
  }

  const storage = file.storages[idx];
  const mountPoint = getStorageMountPath(storage.id);

  try {
    await execFileAsync('umount', [mountPoint]);
  } catch (error) {
    // Best-effort unmount; proceed with cleanup even if already unmounted.
    const message = error instanceof Error ? error.message : String(error);
    log.debug('storage unmount failed', { mountPoint, message });
  }

  // Best-effort cleanup; missing mount dir is fine.
  await bestEffort(() => fsp.rm(mountPoint, { recursive: true, force: true }), {
    fallback: undefined,
    onError: 'debug',
    log,
    label: 'mount point cleanup failed',
    context: { mountPoint },
  });

  const updated = file.storages.filter((entry) => entry.id !== id);
  await saveStorageFile(updated);
  log.info('deleted storage', { id: storage.id, name: storage.name });
}

export async function ensureNasMounts(baseDir: string): Promise<void> {
  // Best-effort listing; if storage config is unreadable, skip mounting.
  const storages = await bestEffort(() => listStorages(), {
    fallback: [],
    onError: 'debug',
    log,
    label: 'list storages failed',
  });

  for (const storage of storages) {
    const mountRoot = path.join(baseDir, 'nas', String(storage.id));
    const meta = { id: storage.id, name: storage.name, mountRoot };
    try {
      await withTimeout(ensureDir(mountRoot), NAS_DIR_TIMEOUT_MS, 'ensure nas mount dir');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('nas mount dir unavailable; skipping', { ...meta, message });
      continue;
    }

    const mounted = await checkMount(mountRoot);
    if (mounted) {
      log.info('storage already mounted', { id: storage.id, name: storage.name });
      continue;
    }

    log.warn('mounting NAS storage', { id: storage.id, name: storage.name });
    try {
      await mountStorage(storage, mountRoot);
      log.info('mounted NAS storage', { id: storage.id, name: storage.name, mountRoot });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('failed to mount NAS storage', { id: storage.id, name: storage.name, message });
    }
  }
}
