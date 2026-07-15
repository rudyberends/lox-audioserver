import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import https from 'node:https';

const repo = 'sonn-audio/adminui';
const assetName = 'admin-dist.tgz';
const release = process.env.ADMINUI_RELEASE ?? 'latest';
const distUrl =
  process.env.ADMINUI_DIST_URL ??
  (release === 'latest'
    ? `https://github.com/${repo}/releases/latest/download/${assetName}`
    : `https://github.com/${repo}/releases/download/${release}/${assetName}`);

const targetDir = join(process.cwd(), 'public', 'admin');
const archivePath = join(tmpdir(), `admin-dist-${Date.now()}.tgz`);
const localAdminUiDir = join(process.cwd(), 'data', 'module_code', 'adminui');
const localAdminUiPackageJson = join(localAdminUiDir, 'package.json');
const localAdminUiDist = join(localAdminUiDir, 'dist');

async function download(url, dest, redirects = 0) {
  if (redirects > 5) {
    throw new Error(`Too many redirects while downloading ${url}`);
  }

  await new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { 'User-Agent': 'sonn-core-admin-fetch' } },
      (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.resume();
          resolve(download(response.headers.location, dest, redirects + 1));
          return;
        }

        if (status !== 200) {
          response.resume();
          reject(new Error(`Failed to download admin dist (${status}) from ${url}`));
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

async function hasLocalAdminUi() {
  if (process.env.ADMINUI_SOURCE?.toLowerCase() === 'remote') return false;
  if (process.env.ADMINUI_SOURCE?.toLowerCase() === 'local') return true;
  try {
    await fs.stat(localAdminUiPackageJson);
    return true;
  } catch {
    return false;
  }
}

async function buildLocalAdminUi(destDir) {
  // Build the checked-in UI (data/module_code/adminui) instead of downloading a release tarball.
  // This keeps UI assets (including provider icons) versioned alongside the UI code.
  await run('npm', ['ci'], { cwd: localAdminUiDir });
  await run('npm', ['run', 'build'], { cwd: localAdminUiDir });
  await fs.cp(localAdminUiDist, destDir, { recursive: true });
}

await fs.rm(targetDir, { recursive: true, force: true });
await fs.mkdir(targetDir, { recursive: true });

if (await hasLocalAdminUi()) {
  await buildLocalAdminUi(targetDir);
} else {
  await download(distUrl, archivePath);
  await extract(archivePath, targetDir);
  await fs.rm(archivePath, { force: true });
}
