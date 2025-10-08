import http from 'http';
import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';
import { BACKEND_OPTIONS, PROVIDER_OPTIONS, AdminConfig, ZoneConfigEntry, defaultAdminConfig } from '../config/configStore';
import { getMusicAssistantSuggestions } from '../config/adminState';
import { reloadConfiguration, getAdminConfig, updateAdminConfig, config as runtimeConfig } from '../config/config';
import { getZoneStatuses, setupZoneById } from '../backend/zone/zonemanager';
import { validateBackendConfig } from '../backend/zone/backendFactory';
import { getMusicAssistantPlayers } from '../backend/zone/MusicAssistant/backend';
import { setMusicAssistantSuggestions } from '../config/adminState';
import { resetMediaProvider } from '../backend/provider/factory';
import logger, { logStreamEmitter } from '../utils/troxorlogger';

/**
 * HTTP layer powering the admin configuration UI and log streaming endpoints.
 */

/**
 * Express-style handler signature consumed by the lightweight router.
 */
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void;

interface Route {
  method: string;
  path: string;
  handler: Handler;
}

const routes: Route[] = [];
const ADMIN_DIR = process.env.CONFIG_ADMIN_DIR || path.resolve(process.cwd(), 'public/admin');
const LOG_FILE_PATH = process.env.AUDIOSERVER_LOG_FILE
  ? path.resolve(process.cwd(), process.env.AUDIOSERVER_LOG_FILE)
  : path.resolve(process.cwd(), 'log/loxone-audio-server.log');
const MAX_LOG_BYTES = Number.isFinite(Number(process.env.AUDIOSERVER_LOG_MAX_BYTES))
  ? Number(process.env.AUDIOSERVER_LOG_MAX_BYTES)
  : 250_000;
const APP_VERSION = (() => {
  try {
    const pkgRaw = fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8');
    const parsed = JSON.parse(pkgRaw) as { version?: string };
    return typeof parsed.version === 'string' ? parsed.version : '';
  } catch (error) {
    logger.warn(`[configHttp] Unable to determine package version: ${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
})();
/**
 * Active server-sent event clients mapped to their heartbeat timers.
 */
const LOG_STREAM_CLIENTS = new Map<http.ServerResponse, NodeJS.Timeout>();
const LOG_STREAM_HEARTBEAT_MS = 15_000;

/**
 * Broadcasts log events to every connected SSE client.
 */
logStreamEmitter.on('log', (payload) => {
  const serialized = JSON.stringify(payload);
  const message = `data: ${serialized}\n\n`;

  for (const [client, heartbeat] of LOG_STREAM_CLIENTS.entries()) {
    if (client.writableEnded) {
      clearInterval(heartbeat);
      LOG_STREAM_CLIENTS.delete(client);
      continue;
    }
    try {
      client.write(message);
    } catch (error) {
      clearInterval(heartbeat);
      LOG_STREAM_CLIENTS.delete(client);
    }
  }
});

/**
 * Registers an admin route with the lightweight router used by {@link handleConfigRequest}.
 */
export function registerConfigRoute(method: string, routePath: string, handler: Handler) {
  routes.push({ method: method.toUpperCase(), path: routePath, handler });
}

/**
 * Attempts to service an admin request and returns whether it was handled.
 */
export async function handleConfigRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const url = req.url || '';
  const [pathOnly] = url.split('?');
  const method = req.method?.toUpperCase() || 'GET';

  const match = routes.find((route) => route.method === method && route.path === pathOnly);
  if (match) {
    try {
      await match.handler(req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[configHttp] Error handling ${url}: ${message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Internal Server Error' }));
    }
    return true;
  }

  if (pathOnly === '/admin' || pathOnly.startsWith('/admin/')) {
    const normalized = pathOnly === '/admin' ? 'index.html' : (pathOnly.replace('/admin', '') || 'index.html');
    const relative = normalized.replace(/^\//, '');
    const filePath = path.join(ADMIN_DIR, relative);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('Not Found');
      return true;
    }
    const contentType = getContentType(path.extname(filePath).toLowerCase());
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath)
      .on('error', (error) => {
        logger.error(`[configHttp] Error streaming ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end('Internal Server Error');
      })
      .pipe(res);
    return true;
  }

  return false;
}

/**
 * Seeds the built-in admin routes and log endpoints for the SPA.
 */
function registerDefaultRoutes() {
  registerConfigRoute('GET', '/admin/api/config', (req, res) => {
    const adminConfig = JSON.parse(JSON.stringify(getAdminConfig())) as AdminConfig;
    const runtime = runtimeConfig.audioserver;
    const mergedConfig = {
      ...adminConfig,
      miniserver: {
        ...adminConfig.miniserver,
        serial: runtimeConfig.miniserver?.serial || adminConfig.miniserver.serial || '',
      },
      audioserver: {
        ip: adminConfig.audioserver.ip,
        paired: Boolean(runtime?.paired),
        name: runtime?.name || '',
      },
    };
    const suggestions = getMusicAssistantSuggestions();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        config: mergedConfig,
        options: {
          backends: BACKEND_OPTIONS,
          providers: PROVIDER_OPTIONS,
        },
        suggestions,
        zoneStatus: getZoneStatuses(),
        version: APP_VERSION,
      }),
    );
  });

  registerConfigRoute('POST', '/admin/api/config', async (req, res) => {
    const body = await readRequestBody(req);
    let payload: { config?: AdminConfig } = {};
    try {
      payload = JSON.parse(body || '{}');
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
      return;
    }

    if (!payload.config) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Missing config payload' }));
      return;
    }

    updateAdminConfig(payload.config);
    await reloadConfiguration();
    resetMediaProvider();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Configuration saved and reloaded.' }));
  });

  registerConfigRoute('POST', '/admin/api/config/reload', async (_req, res) => {
    try {
      await reloadConfiguration();
      resetMediaProvider();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Pairing attempt finished. Check status above.' }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message }));
    }
  });

  registerConfigRoute('POST', '/admin/api/config/clear', async (_req, res) => {
    try {
      const cleared = defaultAdminConfig();
      updateAdminConfig(cleared);
      await reloadConfiguration();
      resetMediaProvider();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Configuration reset to defaults.' }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message }));
    }
  });

  registerConfigRoute('GET', '/admin/api/logs', async (_req, res) => {
    try {
      if (!fs.existsSync(LOG_FILE_PATH)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            log: '',
            truncated: false,
            size: 0,
            missing: true,
            path: path.relative(process.cwd(), LOG_FILE_PATH),
            updatedAt: null,
            limit: MAX_LOG_BYTES,
          }),
        );
        return;
      }

      const stats = await fsp.stat(LOG_FILE_PATH);
      const fileBuffer = await fsp.readFile(LOG_FILE_PATH);
      const sliceStart = fileBuffer.byteLength > MAX_LOG_BYTES ? fileBuffer.byteLength - MAX_LOG_BYTES : 0;
      const truncated = sliceStart > 0;
      const logContent = fileBuffer.subarray(sliceStart).toString('utf8');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          log: logContent,
          truncated,
          size: stats.size,
          missing: false,
          path: path.relative(process.cwd(), LOG_FILE_PATH),
          updatedAt: stats.mtime.toISOString(),
          limit: MAX_LOG_BYTES,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[configHttp] Failed to read logs: ${message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Failed to read logs.' }));
    }
  });

  registerConfigRoute('GET', '/admin/api/logs/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    res.write(': connected\n\n');

    const heartbeat = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(heartbeat);
        return;
      }
      try {
        res.write(': heartbeat\n\n');
      } catch {
        clearInterval(heartbeat);
        LOG_STREAM_CLIENTS.delete(res);
      }
    }, LOG_STREAM_HEARTBEAT_MS);

    LOG_STREAM_CLIENTS.set(res, heartbeat);

    req.on('close', () => {
      clearInterval(heartbeat);
      LOG_STREAM_CLIENTS.delete(res);
    });
  });

  registerConfigRoute('POST', '/admin/api/logs/level', async (req, res) => {
    try {
      const body = await readRequestBody(req);
      let payload: { level?: string } = {};
      try {
        payload = JSON.parse(body || '{}');
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
        return;
      }

      const level = typeof payload.level === 'string' ? payload.level.trim() : '';
      if (!level || !Object.prototype.hasOwnProperty.call(logger.levels, level)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Unknown log level' }));
        return;
      }

      logger.setConsoleLogLevel(level);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: `Log level set to ${level}.` }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[configHttp] Failed to update log level: ${message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Failed to update log level.' }));
    }
  });

  registerConfigRoute('GET', '/admin/api/musicassistant/players', (req, res) => {
    const suggestions = getMusicAssistantSuggestions();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ suggestions }));
  });

  registerConfigRoute('POST', '/admin/api/zones/connect', async (req, res) => {
    try {
      const body = await readRequestBody(req);
      let payload: { playerId?: number; zone?: { id?: number; backend?: string; ip?: string; maPlayerId?: string; name?: string } } = {};
      try {
        payload = JSON.parse(body || '{}');
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
        return;
      }

      const playerId = Number(payload.playerId);
      if (!Number.isFinite(playerId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Missing or invalid playerId' }));
        return;
      }

      let updatedZone: ZoneConfigEntry | undefined;
      if (payload.zone) {
        const currentConfig = getAdminConfig();
        const zones = [...currentConfig.zones];
        const zoneIndex = zones.findIndex((zone) => zone.id === playerId);
        const existingZone = zoneIndex >= 0 ? zones[zoneIndex] : undefined;
        updatedZone = {
          id: playerId,
          backend: payload.zone.backend || existingZone?.backend || 'DummyBackend',
          ip: payload.zone.ip || existingZone?.ip || '127.0.0.1',
          maPlayerId: payload.zone.maPlayerId ?? existingZone?.maPlayerId,
          name: payload.zone.name?.trim() || existingZone?.name,
        };

        try {
          await validateBackendConfig(updatedZone.backend, {
            ip: updatedZone.ip,
            playerId,
            maPlayerId: updatedZone.maPlayerId,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message }));
          return;
        }

        if (zoneIndex >= 0) {
          zones[zoneIndex] = updatedZone;
        } else {
          zones.push(updatedZone);
        }
        updateAdminConfig({
          ...currentConfig,
          zones,
        });
      }

      const success = await setupZoneById(playerId);
      if (!success) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: `Player ${playerId} not found in music configuration.` }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: `Zone ${playerId} connected.`, zoneStatus: getZoneStatuses() }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message }));
    }
  });

  registerConfigRoute('POST', '/admin/api/musicassistant/players', async (req, res) => {
    try {
      const body = await readRequestBody(req);
      let payload: { ip?: string; port?: number; zoneId?: number } = {};
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
        return;
      }

      const ip = (payload.ip || '').trim();
      if (!ip) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Missing Music Assistant host/IP' }));
        return;
      }

      const port = Number.isFinite(payload.port) ? Number(payload.port) : 8095;
      const players = await getMusicAssistantPlayers(ip, port);

      if (Number.isFinite(payload.zoneId)) {
        setMusicAssistantSuggestions(Number(payload.zoneId), players);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, players }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message }));
    }
  });
}

/**
 * Reads the incoming request body as UTF-8 without imposing size limits.
 */
async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req
      .on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      })
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      .on('error', (error) => reject(error));
  });
}

registerDefaultRoutes();

/**
 * Resolves the Content-Type header for static admin files.
 */
function getContentType(ext: string): string {
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}
