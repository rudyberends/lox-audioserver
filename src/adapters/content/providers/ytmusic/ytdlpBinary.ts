import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@/shared/logging/logger';
import { resolveDataDir } from '@/shared/utils/file';

const execFileAsync = promisify(execFile);
const log = createLogger('Content', 'YtDlpBinary');

/**
 * Where an updated yt-dlp lives, and which one a run should use.
 *
 * The image ships a pinned yt-dlp in /usr/local/bin, owned by root while the server
 * runs as `node` — so it cannot update itself in place, and a pin that is right on
 * build day is wrong within weeks: YouTube keeps moving and a stale extractor loses
 * formats (it once left only a 642 MB video file as the way to play a song). Rather
 * than make people wait for an image, an update is downloaded next to the rest of
 * the writable state and simply preferred over the baked-in one.
 */
const RELEASES_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const downloadUrlFor = (version: string): string =>
  `https://github.com/yt-dlp/yt-dlp/releases/download/${encodeURIComponent(version)}/yt-dlp`;

export type YtDlpStatus = {
  /** Version actually in use, or null when no yt-dlp can be run at all. */
  version: string | null;
  /** Path of the binary that would run now. */
  source: string;
  /** True when that path is the managed copy rather than the one from the image. */
  managed: boolean;
  /** Newest published release, when it could be looked up. */
  latest: string | null;
  /** Null when `latest` is unknown, so "unknown" never renders as "up to date". */
  updateAvailable: boolean | null;
};

export function managedBinaryPath(): string {
  return resolveDataDir('bin', 'yt-dlp');
}

/**
 * The binary a run should spawn.
 *
 * `YTDLP_BIN` first, because someone naming a binary outright has said something the
 * managed copy must not quietly overrule — otherwise an update here would override a
 * deliberately chosen yt-dlp with no way to say no. Then the managed copy, then PATH.
 */
export async function resolveYtDlpPath(): Promise<string> {
  const pinned = (process.env.YTDLP_BIN ?? '').trim();
  if (pinned) {
    return pinned;
  }
  const managed = managedBinaryPath();
  try {
    await fsp.access(managed, fsConstants.X_OK);
    return managed;
  } catch {
    return 'yt-dlp';
  }
}

async function versionOf(binary: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binary, ['--version'], { timeout: 20_000 });
    const v = String(stdout ?? '').trim().split('\n')[0]?.trim();
    return v || null;
  } catch {
    return null;
  }
}

export async function latestPublishedVersion(): Promise<string | null> {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'sonn-core' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { tag_name?: unknown };
    const tag = typeof body?.tag_name === 'string' ? body.tag_name.trim() : '';
    return tag || null;
  } catch {
    return null;
  }
}

export async function getYtDlpStatus(): Promise<YtDlpStatus> {
  const source = await resolveYtDlpPath();
  const [version, latest] = await Promise.all([versionOf(source), latestPublishedVersion()]);
  return {
    version,
    source,
    managed: source !== 'yt-dlp',
    latest,
    updateAvailable: latest && version ? latest !== version : null,
  };
}

export type YtDlpUpdateResult =
  | { ok: true; version: string; previous: string | null }
  | { ok: false; error: string };

/**
 * Fetch the newest release and put it in place, but only once it has proven it runs.
 *
 * Downloaded to a temporary name and asked for its own version first: a truncated or
 * wrong-architecture download that replaced a working binary would take playback down
 * until someone rebuilt the image, which is exactly the situation this is meant to end.
 */
export async function updateYtDlp(): Promise<YtDlpUpdateResult> {
  const target = managedBinaryPath();
  const previous = await versionOf(await resolveYtDlpPath());

  const version = await latestPublishedVersion();
  if (!version) {
    return { ok: false, error: 'could not reach the yt-dlp release feed' };
  }

  const tmp = `${target}.download`;
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const res = await fetch(downloadUrlFor(version), {
      redirect: 'follow',
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok || !res.body) {
      return { ok: false, error: `download failed (HTTP ${res.status})` };
    }
    await fsp.writeFile(tmp, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });

    const proven = await versionOf(tmp);
    if (!proven) {
      await fsp.rm(tmp, { force: true });
      return { ok: false, error: 'the downloaded binary did not run' };
    }

    await fsp.rename(tmp, target);
    log.info('yt-dlp updated', { version: proven, previous, path: target });
    return { ok: true, version: proven, previous };
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    log.warn('yt-dlp update failed', { message });
    return { ok: false, error: message };
  }
}
