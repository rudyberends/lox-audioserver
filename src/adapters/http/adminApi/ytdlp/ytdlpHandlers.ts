import type { ServerResponse } from 'node:http';
import type { ComponentLogger } from '@/shared/logging/logger';
import { getYtDlpStatus, updateYtDlp } from '@/adapters/content/providers/ytmusic/ytdlpBinary';
import type { Route } from '@/adapters/http/adminApi/routeTypes';

export type YtDlpHandlerDeps = {
  log: ComponentLogger;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

/**
 * The yt-dlp the YouTube services run on, and a way to move it forward.
 *
 * Not scoped to one configured account: there is a single binary behind every
 * YouTube and YouTube Music service on this server, so its state is the server's,
 * not any one account's.
 */
export function buildYtDlpRoutes(deps: YtDlpHandlerDeps): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/ytdlp\/status$/,
      handler: async (_req, res) => handleStatus(res, deps),
    },
    {
      method: 'POST',
      pattern: /^\/ytdlp\/update$/,
      handler: async (_req, res) => handleUpdate(res, deps),
    },
  ];
}

async function handleStatus(res: ServerResponse, deps: YtDlpHandlerDeps): Promise<void> {
  try {
    deps.sendJson(res, 200, await getYtDlpStatus());
  } catch (err) {
    deps.log.warn('yt-dlp status failed', { err });
    deps.sendJson(res, 500, { error: 'ytdlp-status-failed' });
  }
}

async function handleUpdate(res: ServerResponse, deps: YtDlpHandlerDeps): Promise<void> {
  const result = await updateYtDlp();
  if (!result.ok) {
    // 502, not 500: what failed is the reach out to GitHub or the file it sent back.
    deps.sendJson(res, 502, { error: result.error });
    return;
  }
  deps.sendJson(res, 200, { ...await getYtDlpStatus(), previous: result.previous });
}
