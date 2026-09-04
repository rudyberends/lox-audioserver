import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@/shared/logging/logger';
import { resolveDataDir } from '@/shared/utils/file';
import { resolveYtDlpPath } from '@/adapters/content/providers/ytmusic/ytdlpBinary';

const execFileAsync = promisify(execFile);
const log = createLogger('Content', 'YtDlpPotProvider');

/**
 * The yt-dlp plugin that turns a PO Token server into playable YouTube Music urls.
 *
 * YouTube's `web_music` client will not hand out format urls without a "proof of
 * origin" token, and yt-dlp cannot mint one on its own — asking for that client
 * bare comes back as "Requested format is not available", with no formats at all.
 * The token comes from a small server the user runs, and this plugin is the piece
 * that lets yt-dlp talk to it.
 *
 * It is a 8 KB zip of Python that yt-dlp loads straight out of a plugin directory,
 * so it is managed exactly like the binary next to it: downloaded into the writable
 * data dir rather than baked into the image, and preferred once present.
 */
const RELEASES_API = 'https://api.github.com/repos/Brainicism/bgutil-ytdlp-pot-provider/releases/latest';
const ASSET_NAME = 'bgutil-ytdlp-pot-provider.zip';

/** The provider id yt-dlp prints once the plugin is loaded and usable. */
const HTTP_PROVIDER_ID = 'bgutil:http';

export function pluginDir(): string {
  return resolveDataDir('yt-dlp-plugins');
}

function pluginZipPath(): string {
  return path.join(pluginDir(), ASSET_NAME);
}

function versionMarkerPath(): string {
  return path.join(pluginDir(), '.version');
}

export type PotPluginStatus = {
  /** Version installed here, or null when the plugin is absent. */
  installed: string | null;
  /** Newest published release, when the feed could be reached. */
  latest: string | null;
  /** Null when `latest` is unknown, so "unknown" never reads as "up to date". */
  updateAvailable: boolean | null;
};

async function installedVersion(): Promise<string | null> {
  try {
    await fsp.access(pluginZipPath(), fsConstants.R_OK);
  } catch {
    return null;
  }
  try {
    const marker = (await fsp.readFile(versionMarkerPath(), 'utf8')).trim();
    return marker || 'unknown';
  } catch {
    // The zip is there but we never recorded which release it came from.
    return 'unknown';
  }
}

export async function isPotPluginInstalled(): Promise<boolean> {
  return (await installedVersion()) !== null;
}

/**
 * The `--plugin-dirs` yt-dlp needs to find the plugin, or nothing when it is absent.
 *
 * Returned as args rather than a path so callers can splice it in unconditionally:
 * with no plugin installed this contributes nothing and yt-dlp behaves as before.
 */
export async function potPluginArgs(): Promise<string[]> {
  if (!(await isPotPluginInstalled())) return [];
  return ['--plugin-dirs', pluginDir()];
}

async function latestPublishedRelease(): Promise<{ version: string; url: string } | null> {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'sonn-core' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: unknown; assets?: unknown };
    const version = typeof body?.tag_name === 'string' ? body.tag_name.trim() : '';
    const assets = Array.isArray(body?.assets) ? body.assets : [];
    const asset = assets.find(
      (a): a is { name: string; browser_download_url: string } =>
        typeof (a as { name?: unknown })?.name === 'string' &&
        (a as { name: string }).name === ASSET_NAME &&
        typeof (a as { browser_download_url?: unknown })?.browser_download_url === 'string',
    );
    if (!version || !asset) return null;
    return { version, url: asset.browser_download_url };
  } catch {
    return null;
  }
}

export async function getPotPluginStatus(): Promise<PotPluginStatus> {
  const [installed, latest] = await Promise.all([installedVersion(), latestPublishedRelease()]);
  const latestVersion = latest?.version ?? null;
  return {
    installed,
    latest: latestVersion,
    updateAvailable: latestVersion && installed ? latestVersion !== installed : null,
  };
}

export type PotPluginInstallResult =
  | { ok: true; version: string; previous: string | null }
  | { ok: false; error: string };

/**
 * Fetch the plugin and put it in place, but only once yt-dlp has confirmed it loads.
 *
 * A truncated download or a release that a pinned yt-dlp cannot load would otherwise
 * sit in the plugin dir looking installed while every extraction quietly went on
 * without a PO token — the failure this whole path exists to remove. So the zip is
 * staged under a temporary name and yt-dlp is asked whether the provider actually
 * registered before anything replaces a working install.
 */
export async function installPotPlugin(): Promise<PotPluginInstallResult> {
  const previous = await installedVersion();
  const release = await latestPublishedRelease();
  if (!release) {
    return { ok: false, error: 'could not reach the PO Token provider release feed' };
  }

  const dir = pluginDir();
  const staging = path.join(dir, `.staging-${process.pid}`);
  try {
    await fsp.mkdir(staging, { recursive: true });
    const res = await fetch(release.url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
    if (!res.ok) {
      return { ok: false, error: `download failed (HTTP ${res.status})` };
    }
    const stagedZip = path.join(staging, ASSET_NAME);
    await fsp.writeFile(stagedZip, Buffer.from(await res.arrayBuffer()), { mode: 0o644 });

    if (!(await providerLoadsFrom(staging))) {
      return { ok: false, error: 'yt-dlp could not load the downloaded plugin' };
    }

    await fsp.rename(stagedZip, pluginZipPath());
    await fsp.writeFile(versionMarkerPath(), `${release.version}\n`, 'utf8');
    log.info('yt-dlp PO Token provider plugin installed', { version: release.version, previous, dir });
    return { ok: true, version: release.version, previous };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('yt-dlp PO Token provider plugin install failed', { message });
    return { ok: false, error: message };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Ask yt-dlp itself whether the plugin in `dir` registers the HTTP provider. */
async function providerLoadsFrom(dir: string): Promise<boolean> {
  const ytDlpPath = await resolveYtDlpPath();
  try {
    // `--simulate --verbose` on a url it never fetches: the plugin listing is printed
    // during extractor setup, which is as far as this needs to get.
    const { stdout, stderr } = await execFileAsync(
      ytDlpPath,
      ['--plugin-dirs', dir, '--verbose', '--simulate', '--playlist-items', '0', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ'],
      { timeout: 60_000, maxBuffer: 1024 * 1024 * 8 },
    ).catch((err: { stdout?: unknown; stderr?: unknown }) => ({
      // A non-zero exit is fine here; the listing is on stderr either way.
      stdout: String(err?.stdout ?? ''),
      stderr: String(err?.stderr ?? ''),
    }));
    return `${stdout}${stderr}`.includes(HTTP_PROVIDER_ID);
  } catch {
    return false;
  }
}
