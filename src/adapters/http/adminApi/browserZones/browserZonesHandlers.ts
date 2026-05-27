import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Route } from '@/adapters/http/adminApi/routeTypes';
import type { BrowserZoneRegistry } from '@/application/zones/browserZoneRegistry';
import type { ComponentLogger } from '@/shared/logging/logger';

export type BrowserZonesHandlerDeps = {
  log: ComponentLogger;
  registry: BrowserZoneRegistry;
  readJsonBody: (req: IncomingMessage, res: ServerResponse, maxBytes?: number) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

export function buildBrowserZonesRoutes(deps: BrowserZonesHandlerDeps): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/zones\/browser$/,
      handler: async (_req, res) => {
        deps.sendJson(res, 200, { zones: deps.registry.list() });
      },
    },
    {
      method: 'POST',
      pattern: /^\/zones\/browser$/,
      handler: async (req, res) => {
        const body = (await deps.readJsonBody(req, res, 2048)) as
          | { name?: unknown; serial?: unknown }
          | null;
        if (body === undefined) return; // readJsonBody already sent the error response

        const name = typeof body?.name === 'string' ? body.name : undefined;
        const serial = typeof body?.serial === 'string' ? body.serial : undefined;

        try {
          const record = await deps.registry.register({ name, serial });
          deps.sendJson(res, 201, {
            zoneId: record.zoneId,
            name: record.name,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.log.warn('browser zone register failed', { message });
          deps.sendJson(res, 500, { error: 'register-failed', message });
        }
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/zones\/browser\/(\d+)$/,
      handler: async (_req, res, match) => {
        const zoneId = Number(match[1]);
        if (!Number.isFinite(zoneId)) {
          deps.sendJson(res, 400, { error: 'invalid-zone-id' });
          return;
        }
        const removed = await deps.registry.unregister(zoneId);
        if (!removed) {
          deps.sendJson(res, 404, { error: 'unknown-browser-zone' });
          return;
        }
        deps.sendJson(res, 200, { ok: true, zoneId });
      },
    },
  ];
}
