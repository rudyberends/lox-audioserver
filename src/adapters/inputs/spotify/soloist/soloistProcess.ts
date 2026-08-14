import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@/shared/logging/logger';
import { resolveDataDir } from '@/shared/utils/file';

const log = createLogger('Audio', 'SoloistProcess');

/** Where the user's own Soloist build lives. Never shipped — Spotify forbids redistributing it. */
export function soloistBinaryPath(): string {
  return resolveDataDir('soloist', 'soloist');
}

/** One paired Spotify session per zone. A data dir holds a `.lock`, so it cannot be shared. */
export function soloistDataDir(zoneId: number): string {
  return resolveDataDir('soloist', `zone-${zoneId}`, 'data');
}

export function soloistCacheDir(zoneId: number): string {
  return resolveDataDir('soloist', `zone-${zoneId}`, 'cache');
}

export type SoloistBinaryStatus = {
  present: boolean;
  executable: boolean;
  version?: string;
  /** Days left before this build stops working, from its own build stamp. Can be negative. */
  expiresInDays?: number;
  /** When it stops working, epoch ms. */
  expiresAt?: number;
  error?: string;
};

/** Spotify gives a build ninety days, then it exits with code 10 whatever else is right. */
export const SOLOIST_BUILD_LIFETIME_DAYS = 90;

/**
 * The streaming quality this zone asks Spotify for.
 *
 * Set per Connect device, not per account, and it defaults to Spotify's "Automatic" — so without
 * this every room would have to be found in the Spotify app and switched to lossless by hand,
 * in a screen most people never open. Soloist keeps it in the same plain `key=value` file the app
 * writes, and does not overwrite it on login, so setting it here holds.
 *
 * Only two states are worth offering: lossless, or leave Spotify to decide. The intermediate
 * tiers are bitrate ceilings for metered connections, which is not what a wired room needs.
 */
const QUALITY_PREF = 'audio.play_bitrate_non_metered_enumeration';
const QUALITY_LOSSLESS = '5';

export async function applyQualityPreference(zoneId: number, lossless: boolean): Promise<void> {
  const usersDir = path.join(soloistDataDir(zoneId), 'settings', 'Users');
  let accounts: string[];
  try {
    accounts = await fsp.readdir(usersDir);
  } catch {
    // No account has signed in yet; the next start after pairing writes it.
    return;
  }
  for (const account of accounts) {
    const prefsPath = path.join(usersDir, account, 'prefs');
    let lines: string[];
    try {
      lines = (await fsp.readFile(prefsPath, 'utf8')).split('\n');
    } catch {
      continue;
    }
    const kept = lines.filter((line) => line.trim() && !line.startsWith(`${QUALITY_PREF}=`));
    if (lossless) {
      kept.push(`${QUALITY_PREF}=${QUALITY_LOSSLESS}`);
    }
    const next = `${kept.join('\n')}\n`;
    await fsp.writeFile(prefsPath, next, 'utf8').catch(() => undefined);
  }
  log.debug('soloist quality preference applied', { zoneId, lossless });
}

/** Whether this zone has been through a handshake in the Spotify app. */
export async function isZonePaired(zoneId: number): Promise<boolean> {
  try {
    const entries = await fsp.readdir(soloistDataDir(zoneId));
    // Pairing leaves a full client profile behind, not a portable blob; `settings` is the part
    // that only exists once a login has actually happened.
    return entries.includes('settings');
  } catch {
    return false;
  }
}

/**
 * Soloist buffers stdout when it is not attached to a terminal, so its own log file is the only
 * place its lines reliably appear. Everything here reads that file rather than the pipe.
 */
function logPathFor(zoneId: number | 'probe'): string {
  return resolveDataDir('soloist', `soloist-${zoneId}.log`);
}

const EXPIRY_RE = /client expires in (\d+) days/i;
const VERSION_RE = /^soloist ([^\s]+)/im;
/**
 * `soloist 1.3.7.150 build 1786723306 (20260814) …` — the epoch seconds it was built.
 *
 * Reading it means the expiry is known the moment the file is uploaded, rather than only after
 * something has played and Soloist has said so itself on its way up.
 */
const BUILD_STAMP_RE = /\bbuild (\d{10})\b/;
/** Soloist exits with 10 when its build has passed the 90-day mark. Worth naming, not guessing. */
export const SOLOIST_EXIT_EXPIRED = 10;

export async function probeBinary(): Promise<SoloistBinaryStatus> {
  const binary = soloistBinaryPath();
  try {
    const stat = await fsp.stat(binary);
    if (!stat.isFile()) {
      return { present: false, executable: false };
    }
  } catch {
    return { present: false, executable: false };
  }
  try {
    await fsp.access(binary, (await import('node:fs')).constants.X_OK);
  } catch {
    return { present: true, executable: false, error: 'not_executable' };
  }
  const output = await runToCompletion(binary, ['--version'], {}, 8000);
  const version = VERSION_RE.exec(output.text)?.[1];
  const builtAt = Number(BUILD_STAMP_RE.exec(output.text)?.[1] ?? 0);
  if (!builtAt) {
    return { present: true, executable: true, version };
  }
  const expiresAt = (builtAt + SOLOIST_BUILD_LIFETIME_DAYS * 86_400) * 1000;
  return {
    present: true,
    executable: true,
    version,
    expiresAt,
    expiresInDays: Math.floor((expiresAt - Date.now()) / 86_400_000),
  };
}

async function runToCompletion(
  binary: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ code: number | null; text: string }> {
  return new Promise((resolve) => {
    let text = '';
    let child: ChildProcess;
    try {
      child = spawn(binary, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: null, text: error instanceof Error ? error.message : String(error) });
      return;
    }
    const collect = (chunk: Buffer): void => {
      text += chunk.toString('utf8');
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, text: `${text}\n${error.message}` });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, text });
    });
  });
}

export type SoloistRunHandle = {
  /** Resolves with the exit code once the track is done and the process has gone. */
  done: Promise<number | null>;
  stop: () => void;
  /** Days left, once the startup line has been seen. */
  expiresInDays: Promise<number | undefined>;
};

/**
 * Run one zone's Soloist for as long as the zone exists.
 *
 * Persistent rather than per track, because the data directory holds a lock: a zone gets one
 * instance and no more. Wanting the zone to appear in the Spotify app at all means that instance
 * has to stay up, which leaves nothing for a per-track process to run in — and makes the question
 * moot, since driving the running one over its WebSocket does the same job without paying a fresh
 * login on every track.
 */
export function startPersistent(params: {
  zoneId: number;
  apiKey: string;
  deviceName: string;
  env: Record<string, string>;
  onLine?: (line: string) => void;
}): SoloistRunHandle {
  const { zoneId, apiKey, deviceName, env, onLine } = params;
  const args = [
    '-n', deviceName,
    '-k', apiKey,
    '-D', soloistDataDir(zoneId),
    '-C', soloistCacheDir(zoneId),
    // Port 0: Soloist picks a free one and writes it to <data-dir>/ws.port, so zones cannot collide.
    '-w', '127.0.0.1:0',
    // Volume belongs to the engine. Anything below 100 is applied in software before the sink and
    // ends the bit-exactness this backend exists for.
    '-i', '100',
  ];
  return runTracked(zoneId, args, env, 'persistent', onLine);
}

function runTracked(
  zoneId: number,
  args: string[],
  env: Record<string, string>,
  what: string,
  onLine?: (line: string) => void,
): SoloistRunHandle {
  const binary = soloistBinaryPath();
  let resolveExpiry: (value: number | undefined) => void = () => undefined;
  const expiresInDays = new Promise<number | undefined>((resolve) => {
    resolveExpiry = resolve;
  });

  let child: ChildProcess | null = null;
  const done = new Promise<number | null>((resolve) => {
    try {
      child = spawn(binary, args, {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('soloist could not be started', { zoneId, what, message });
      resolveExpiry(undefined);
      resolve(null);
      return;
    }

    const logPath = logPathFor(zoneId);
    const lines: string[] = [];
    const onOutput = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      lines.push(text);
      const expiry = EXPIRY_RE.exec(text);
      if (expiry?.[1]) {
        resolveExpiry(Number(expiry[1]));
      }
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          log.debug('soloist', { zoneId, line: trimmed.slice(0, 300) });
          onLine?.(trimmed);
        }
      }
    };
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);

    child.on('error', (error) => {
      log.warn('soloist failed', { zoneId, what, message: error.message });
      resolveExpiry(undefined);
      resolve(null);
    });
    child.on('exit', (code) => {
      resolveExpiry(undefined);
      if (code === SOLOIST_EXIT_EXPIRED) {
        log.error('this Soloist build has expired; download a newer one', { zoneId });
      }
      // Keep the tail on disk: without a terminal Soloist buffers, so this is the only record of
      // what it said when something goes wrong.
      void fsp
        .writeFile(logPath, lines.join('').slice(-64_000), 'utf8')
        .catch(() => undefined);
      log.debug('soloist exited', { zoneId, what, code });
      resolve(code);
    });
  });

  return {
    done,
    expiresInDays,
    stop: () => {
      if (child && child.exitCode === null) {
        child.kill();
      }
    },
  };
}

export function soloistLogPath(zoneId: number): string {
  return path.resolve(logPathFor(zoneId));
}
