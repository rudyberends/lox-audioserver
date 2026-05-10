import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import type { ComponentLogger } from '@/shared/logging/logger';
import type { AlertFilesPort } from '@/ports/AlertFilesPort';
import { ensureDir } from '@/shared/utils/file';
import type { Route } from '@/adapters/http/adminApi/routeTypes';

const MAX_EVENT_SOUND_UPLOAD_JSON_BODY_BYTES = 32 * 1024 * 1024;
const EVENT_SOUNDS_DIR = resolve(process.cwd(), 'public', 'alerts', 'Event_Sounds');
const ALLOWED_EVENT_SOUND_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);

export type AlertsHandlerDeps = {
  log: ComponentLogger;
  readJsonBody: (req: IncomingMessage, res: ServerResponse, maxBytes?: number) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  alertFiles: AlertFilesPort;
};

export function buildAlertsRoutes(deps: AlertsHandlerDeps): Route[] {
  return [
    {
      method: 'POST',
      pattern: /^\/alerts\/event-sounds\/upload$/,
      handler: async (req, res) => handleEventSoundUpload(req, res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/alerts\/files$/,
      handler: async (_req, res) => handleAlertFilesList(res, deps),
    },
    {
      method: 'POST',
      pattern: /^\/alerts\/files\/([^/]+)(?:\/([^/]+))?$/,
      handler: async (req, res, match) => {
        const alertId = decodeURIComponent(match[1] ?? '');
        const action = match[2];
        if (!alertId) {
          deps.sendJson(res, 400, { error: 'invalid-alert-id' });
          return;
        }
        if (action === 'revert') {
          await handleAlertFileRevert(alertId, res, deps);
        } else {
          await handleAlertFileUpdate(req, res, alertId, deps);
        }
      },
    },
  ];
}

async function handleEventSoundUpload(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AlertsHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res, MAX_EVENT_SOUND_UPLOAD_JSON_BODY_BYTES)) as
    | { filename?: string; data?: string }
    | null;
  if (res.writableEnded) {
    return;
  }
  const inputFilename = typeof body?.filename === 'string' ? body.filename.trim() : '';
  const data = typeof body?.data === 'string' ? body.data.trim() : '';
  const filename = sanitizeEventSoundFilename(inputFilename);
  if (!filename || !data) {
    deps.sendJson(res, 400, { error: 'invalid-event-sound-upload' });
    return;
  }
  const extension = extname(filename).toLowerCase();
  if (!ALLOWED_EVENT_SOUND_EXTENSIONS.has(extension)) {
    deps.sendJson(res, 400, { error: 'invalid-audio-extension' });
    return;
  }

  let payload: Buffer;
  try {
    payload = Buffer.from(data, 'base64');
  } catch {
    deps.sendJson(res, 400, { error: 'invalid-audio-data' });
    return;
  }
  if (!payload.length) {
    deps.sendJson(res, 400, { error: 'invalid-audio-data' });
    return;
  }

  try {
    await ensureDir(EVENT_SOUNDS_DIR);
    await fs.writeFile(join(EVENT_SOUNDS_DIR, filename), payload);
    deps.sendJson(res, 201, {
      upload: {
        filename,
        relativePath: `Event_Sounds/${filename}`,
        bytes: payload.length,
      },
    });
  } catch (err) {
    deps.log.warn('event sound upload failed', { err, filename });
    deps.sendJson(res, 500, { error: 'event-sound-upload-failed' });
  }
}

async function handleAlertFilesList(res: ServerResponse, deps: AlertsHandlerDeps): Promise<void> {
  try {
    const alerts = await deps.alertFiles.list();
    deps.sendJson(res, 200, { alerts });
  } catch (err) {
    deps.log.warn('alerts list failed', { err });
    deps.sendJson(res, 500, { error: 'alerts-list-failed' });
  }
}

async function handleAlertFileUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  alertId: string,
  deps: AlertsHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as { data?: string } | null;
  if (res.writableEnded) {
    return;
  }
  const data = typeof body?.data === 'string' ? body.data : null;
  if (!data) {
    deps.sendJson(res, 400, { error: 'invalid-alert-payload' });
    return;
  }
  try {
    await deps.alertFiles.update(alertId, data);
    deps.sendJson(res, 200, { success: true });
  } catch (err) {
    const code = err instanceof Error ? err.message : 'alerts-update-failed';
    deps.log.warn('alert update failed', { err, alertId });
    deps.sendJson(res, 500, { error: code });
  }
}

async function handleAlertFileRevert(
  alertId: string,
  res: ServerResponse,
  deps: AlertsHandlerDeps,
): Promise<void> {
  try {
    await deps.alertFiles.revert(alertId);
    deps.sendJson(res, 200, { success: true });
  } catch (err) {
    const code = err instanceof Error ? err.message : 'alerts-revert-failed';
    deps.log.warn('alert revert failed', { err, alertId });
    if (code === 'no-alert-backup') {
      deps.sendJson(res, 400, { error: 'no-alert-backup' });
      return;
    }
    deps.sendJson(res, 500, { error: code });
  }
}

function sanitizeEventSoundFilename(input: string): string | null {
  if (!input) {
    return null;
  }
  const leaf = basename(input.replace(/\\/g, '/')).trim();
  if (!leaf || leaf === '.' || leaf === '..') {
    return null;
  }
  if (/[<>:"|?*\x00-\x1f]/.test(leaf)) {
    return null;
  }
  return leaf;
}
