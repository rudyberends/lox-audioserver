import type { ServerResponse } from 'node:http';
import type { ComponentLogger } from '@/shared/logging/logger';
import type { LineInApiHandler } from '@/adapters/http/lineInApi/lineInApiHandler';
import type { Route } from '@/adapters/http/adminApi/routeTypes';

export type LineInAdminHandlerDeps = {
  log: ComponentLogger;
  lineInApi: LineInApiHandler;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

/**
 * Auth-gated, read-only admin views of the line-in bridges. The mutating + device-facing surface
 * (register, status push, config, ingest) stays in LineInApiHandler under the ungated /api/linein
 * namespace, where bridge devices — which have no admin session — can reach it. The admin UI only
 * reads, so it gets those reads here, under /admin/api, consistent with every other content view.
 */
export function buildLineInRoutes(deps: LineInAdminHandlerDeps): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/linein\/bridges$/,
      handler: (_req, res) => {
        try {
          deps.sendJson(res, 200, deps.lineInApi.listBridgesForAdmin());
        } catch (err) {
          deps.log.warn('line-in bridges list failed', { err });
          deps.sendJson(res, 500, { error: 'linein-bridges-failed' });
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/linein\/([^/]+)\/bridge-status$/,
      handler: (_req, res, match) => {
        const inputId = decodeURIComponent(match[1] ?? '').trim();
        if (!inputId) {
          deps.sendJson(res, 400, { error: 'missing-linein-id' });
          return;
        }
        try {
          const status = deps.lineInApi.getBridgeStatusForAdmin(inputId);
          if (!status) {
            deps.sendJson(res, 404, { error: 'linein-not-found' });
            return;
          }
          deps.sendJson(res, 200, status);
        } catch (err) {
          deps.log.warn('line-in bridge status failed', { err, inputId });
          deps.sendJson(res, 500, { error: 'linein-bridge-status-failed' });
        }
      },
    },
  ];
}
