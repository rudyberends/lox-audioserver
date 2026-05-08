import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ComponentLogger } from '@/shared/logging/logger';
import {
  invalidateWidevineArtifactsCache,
  loadWidevineArtifacts,
  WidevineArtifactsError,
} from '@/adapters/content/providers/applemusic/widevine';
import { ensureDir, resolveDataDir } from '@/shared/utils/file';
import type { Route } from '@/adapters/http/adminApi/routeTypes';

const MAX_WIDEVINE_PRIVATE_KEY_BYTES = 256 * 1024;
const MAX_WIDEVINE_CLIENT_ID_BYTES = 10 * 1024 * 1024;

export type AppleMusicHandlerDeps = {
  log: ComponentLogger;
  readBinaryBody: (req: IncomingMessage, res: ServerResponse, maxBytes: number) => Promise<Buffer | null>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  sendHtml: (res: ServerResponse, status: number, html: string) => void;
};

export function buildAppleMusicRoutes(deps: AppleMusicHandlerDeps): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/applemusic\/auth$/,
      handler: async (req, res) => handleAppleMusicAuth(req, res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/applemusic\/widevine\/status$/,
      handler: async (_req, res) => handleAppleMusicWidevineStatus(res, deps),
    },
    {
      method: 'PUT',
      pattern: /^\/applemusic\/widevine\/private-key$/,
      handler: async (req, res) => handleAppleMusicWidevineUpload(req, res, 'privateKey', deps),
    },
    {
      method: 'PUT',
      pattern: /^\/applemusic\/widevine\/client-id$/,
      handler: async (req, res) => handleAppleMusicWidevineUpload(req, res, 'clientId', deps),
    },
  ];
}

async function handleAppleMusicAuth(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: AppleMusicHandlerDeps,
): Promise<void> {
  try {
    const developerToken = await fetchAppleMusicDeveloperToken(deps.log);
    if (!developerToken) {
      deps.sendHtml(res, 500, renderAppleMusicAuthError('Apple Music token unavailable. Try again.'));
      return;
    }
    const html = renderAppleMusicAuthPage({
      developerToken,
      appName: 'Loxone Audio Server',
    });
    deps.sendHtml(res, 200, html);
  } catch (err) {
    deps.log.warn('apple music auth page failed', { err });
    deps.sendHtml(res, 500, renderAppleMusicAuthError('Apple Music token fetch failed.'));
  }
}

async function handleAppleMusicWidevineStatus(
  res: ServerResponse,
  deps: AppleMusicHandlerDeps,
): Promise<void> {
  const files = await readWidevineFileStatus();
  try {
    invalidateWidevineArtifactsCache();
    await loadWidevineArtifacts();
    deps.sendJson(res, 200, { ok: true, status: 'valid', files });
  } catch (err) {
    if (err instanceof WidevineArtifactsError) {
      deps.sendJson(res, 200, { ok: false, status: err.code, details: err.details, files });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    deps.sendJson(res, 200, { ok: false, status: 'error', details: [message], files });
  }
}

async function handleAppleMusicWidevineUpload(
  req: IncomingMessage,
  res: ServerResponse,
  kind: 'privateKey' | 'clientId',
  deps: AppleMusicHandlerDeps,
): Promise<void> {
  const maxBytes = kind === 'privateKey' ? MAX_WIDEVINE_PRIVATE_KEY_BYTES : MAX_WIDEVINE_CLIENT_ID_BYTES;
  const body = await deps.readBinaryBody(req, res, maxBytes);
  if (res.writableEnded) return;
  if (!body || body.length === 0) {
    deps.sendJson(res, 400, { error: 'empty-body' });
    return;
  }

  const cdmDir = resolveDataDir('widevine_cdm');
  const targetPath =
    kind === 'privateKey'
      ? join(cdmDir, 'private_key.pem')
      : join(cdmDir, 'client_id.bin');

  try {
    await ensureDir(cdmDir);
    await fs.writeFile(targetPath, body, { mode: 0o600 });
    invalidateWidevineArtifactsCache();
    try {
      await loadWidevineArtifacts();
    } catch (err) {
      if (err instanceof WidevineArtifactsError) {
        const files = await readWidevineFileStatus();
        deps.sendJson(res, 200, { ok: false, status: err.code, details: err.details, files });
        return;
      }
      throw err;
    }
    const files = await readWidevineFileStatus();
    deps.sendJson(res, 200, { ok: true, status: 'valid', files });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log.warn('widevine upload failed', { kind, message });
    deps.sendJson(res, 500, { error: 'widevine-upload-failed', message });
  }
}

async function readWidevineFileStatus(): Promise<{
  privateKey: { present: boolean; bytes: number };
  clientId: { present: boolean; bytes: number };
}> {
  const cdmDir = resolveDataDir('widevine_cdm');
  const privatePath = join(cdmDir, 'private_key.pem');
  const clientPath = join(cdmDir, 'client_id.bin');
  const readOne = async (filePath: string): Promise<{ present: boolean; bytes: number }> => {
    try {
      const stat = await fs.stat(filePath);
      return { present: stat.isFile(), bytes: stat.isFile() ? stat.size : 0 };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { present: false, bytes: 0 };
      }
      return { present: false, bytes: 0 };
    }
  };
  const [privateKey, clientId] = await Promise.all([readOne(privatePath), readOne(clientPath)]);
  return { privateKey, clientId };
}

async function fetchAppleMusicDeveloperToken(log: ComponentLogger): Promise<string | null> {
  const headers = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US',
    'Accept-Encoding': 'utf-8',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:95.0) Gecko/20100101 Firefox/95.0',
  };
  try {
    const homeRes = await fetch('https://music.apple.com', { headers });
    const homeText = await homeRes.text();
    const match = homeText.match(/\/(assets\/index-legacy[~-][^/"]+\.js)/i);
    if (!match) {
      log.warn('apple music auth: index js not found');
      return null;
    }
    const jsRes = await fetch(`https://music.apple.com/${match[1]}`, { headers });
    const jsText = await jsRes.text();
    const tokenMatch = jsText.match(/eyJh[^"]+/);
    if (!tokenMatch) {
      log.warn('apple music auth: bearer token not found');
      return null;
    }
    return tokenMatch[0];
  } catch (err) {
    log.warn('apple music auth: token fetch failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function renderAppleMusicAuthError(message: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Apple Music Sign-in</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: #0f0f10; color: #f2f2f2; margin: 0; padding: 24px; }
      .card { max-width: 420px; margin: 8vh auto 0; padding: 24px; background: #1c1c1f; border-radius: 12px; box-shadow: 0 20px 50px rgba(0,0,0,.45); }
      h1 { font-size: 20px; margin: 0 0 12px; }
      p { margin: 0 0 16px; color: #bdbdbd; }
      button { appearance: none; border: 0; background: #d92b2b; color: #fff; padding: 10px 16px; border-radius: 8px; cursor: pointer; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Apple Music Sign-in</h1>
      <p>${message}</p>
      <button onclick="window.close()">Close</button>
    </div>
  </body>
</html>`;
}

function renderAppleMusicAuthPage(payload: { developerToken: string; appName: string }): string {
  const developerToken = JSON.stringify(payload.developerToken);
  const appName = JSON.stringify(payload.appName);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="strict-origin-when-cross-origin" />
    <title>Apple Music Sign-in</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: radial-gradient(1200px 700px at 10% 10%, #2a2a2f 0%, #0f0f10 65%); color: #f2f2f2; margin: 0; padding: 24px; }
      .card { max-width: 440px; margin: 6vh auto 0; padding: 28px; background: #1c1c1f; border-radius: 16px; box-shadow: 0 24px 60px rgba(0,0,0,.5); }
      h1 { font-size: 22px; margin: 0 0 8px; }
      p { margin: 0 0 16px; color: #c9c9c9; line-height: 1.4; }
      .actions { display: flex; gap: 12px; flex-wrap: wrap; }
      button { appearance: none; border: 0; background: #f23d4f; color: #fff; padding: 10px 16px; border-radius: 10px; cursor: pointer; font-weight: 600; }
      button.secondary { background: #2a2a2f; color: #f2f2f2; }
      button[disabled] { opacity: .6; cursor: default; }
      .status { margin-top: 16px; font-size: 13px; color: #9f9fa4; }
    </style>
    <script src="https://js-cdn.music.apple.com/musickit/v3/musickit.js" data-web-components async></script>
  </head>
  <body>
    <div class="card">
      <h1>Apple Music Sign-in</h1>
      <p>Sign in with Apple to fetch your Media User Token for the Apple Music bridge.</p>
      <div class="actions">
        <button id="signin" disabled>Sign in</button>
        <button id="close" class="secondary">Close</button>
      </div>
      <div id="status" class="status">Loading MusicKit…</div>
    </div>
    <script>
      const developerToken = ${developerToken};
      const appName = ${appName};
      const statusEl = document.getElementById('status');
      const signInBtn = document.getElementById('signin');
      const closeBtn = document.getElementById('close');
      let musicInstance = null;

      function setStatus(text) {
        statusEl.textContent = text;
      }

      function sendToken(token) {
        if (!window.opener || !token) return;
        window.opener.postMessage({ type: 'applemusic-token', token }, window.location.origin);
      }

      closeBtn.addEventListener('click', () => window.close());
      signInBtn.addEventListener('click', async () => {
        if (!musicInstance) return;
        signInBtn.disabled = true;
        setStatus('Opening Apple Music sign-in…');
        try {
          const token = await musicInstance.authorize();
          setStatus('Token received. You can close this window.');
          sendToken(token);
          setTimeout(() => window.close(), 500);
        } catch (err) {
          console.error('Apple Music sign-in failed', err);
          setStatus('Sign-in failed. Please try again.');
          signInBtn.disabled = false;
        }
      });

      document.addEventListener('musickitloaded', async () => {
        try {
          await MusicKit.configure({
            developerToken,
            app: { name: appName, build: '0.0.0' },
          });
          musicInstance = MusicKit.getInstance();
          signInBtn.disabled = false;
          setStatus(musicInstance.isAuthorized ? 'Already signed in. Click sign in to refresh.' : 'Ready to sign in.');
        } catch (err) {
          console.error('MusicKit init failed', err);
          setStatus('Unable to initialize MusicKit.');
        }
      });
    </script>
  </body>
</html>`;
}
