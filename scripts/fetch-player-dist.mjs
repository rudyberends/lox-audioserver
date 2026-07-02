import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import https from 'node:https';

const repo = 'lox-audioserver/player';
const assetName = 'player-dist.tgz';
const release = process.env.PLAYER_RELEASE ?? 'latest';
const distUrl =
  process.env.PLAYER_DIST_URL ??
  (release === 'latest'
    ? `https://github.com/${repo}/releases/latest/download/${assetName}`
    : `https://github.com/${repo}/releases/download/${release}/${assetName}`);

const targetDir = join(process.cwd(), 'public', 'player');
const archivePath = join(tmpdir(), `player-dist-${Date.now()}.tgz`);
const localPlayerDir = join(process.cwd(), 'data', 'module_code', 'player');
const localPlayerPackageJson = join(localPlayerDir, 'package.json');
const localPlayerDist = join(localPlayerDir, 'dist');

async function download(url, dest, redirects = 0) {
  if (redirects > 5) {
    throw new Error(`Too many redirects while downloading ${url}`);
  }

  await new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { 'User-Agent': 'sonn-core-player-fetch' } },
      (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.resume();
          resolve(download(response.headers.location, dest, redirects + 1));
          return;
        }

        if (status !== 200) {
          response.resume();
          reject(new Error(`Failed to download player dist (${status}) from ${url}`));
          return;
        }

        pipeline(response, createWriteStream(dest)).then(resolve).catch(reject);
      },
    );

    request.on('error', reject);
  });
}

async function extract(archive, dest) {
  await new Promise((resolve, reject) => {
    const proc = spawn('tar', ['-xzf', archive, '-C', dest], { stdio: 'inherit' });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar exited with code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

async function run(cmd, args, options = {}) {
  await new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'inherit', ...options });
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
    proc.on('error', reject);
  });
}

async function hasLocalPlayer() {
  if (process.env.PLAYER_SOURCE?.toLowerCase() === 'remote') return false;
  if (process.env.PLAYER_SOURCE?.toLowerCase() === 'local') return true;
  try {
    await fs.stat(localPlayerPackageJson);
    return true;
  } catch {
    return false;
  }
}

async function buildLocalPlayer(destDir) {
  await run('npm', ['ci'], { cwd: localPlayerDir });
  await run('npm', ['run', 'build'], { cwd: localPlayerDir });
  await fs.cp(localPlayerDist, destDir, { recursive: true });
}

await fs.rm(targetDir, { recursive: true, force: true });
await fs.mkdir(targetDir, { recursive: true });

if (await hasLocalPlayer()) {
  await buildLocalPlayer(targetDir);
} else {
  try {
    await download(distUrl, archivePath);
    await extract(archivePath, targetDir);
    await fs.rm(archivePath, { force: true });
  } catch (err) {
    // The player UI is an optional bundle. When no release is available (e.g.
    // during the sonn-audio move, before player publishes releases there),
    // don't fail the build — ship without it and leave public/player empty.
    // The server and admin UI still work; /player just 404s until a dist lands.
    console.warn(`[fetch:player] skipping player dist: ${err instanceof Error ? err.message : err}`);
    await fs.rm(archivePath, { force: true }).catch(() => {});
  }
}
