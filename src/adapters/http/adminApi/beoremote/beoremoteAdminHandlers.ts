import type { ServerResponse } from 'node:http';
import type { ComponentLogger } from '@/shared/logging/logger';
import type { BeoremoteApiHandler } from '@/adapters/http/beoremote/beoremoteApiHandler';
import type { Route } from '@/adapters/http/adminApi/routeTypes';

export type BeoremoteAdminHandlerDeps = {
  log: ComponentLogger;
  beoremoteApi: BeoremoteApiHandler;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

/**
 * Auth-gated, read-only admin view for the Beoremote UI: what each key on a zone
 * can be bound to, with names.
 *
 * There is no bridge list here because there are no bridges to track — a bridge
 * names the zone it drives in its own config. Writes go through the zone config.
 */
export function buildBeoremoteRoutes(deps: BeoremoteAdminHandlerDeps): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/beoremote\/zones\/(\d+)\/keys$/,
      handler: async (_req, res, match) => {
        const zoneId = Number(match[1]);
        if (!Number.isFinite(zoneId) || zoneId <= 0) {
          deps.sendJson(res, 400, { error: 'invalid-zone-id' });
          return;
        }
        try {
          const options = await deps.beoremoteApi.getKeyOptionsForAdmin(zoneId);
          if (!options) {
            deps.sendJson(res, 404, { error: 'zone-not-found' });
            return;
          }
          deps.sendJson(res, 200, options);
        } catch (err) {
          deps.log.warn('beoremote key options failed', { err, zoneId });
          deps.sendJson(res, 500, { error: 'beoremote-keys-failed' });
        }
      },
    },
  ];
}
