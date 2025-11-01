import http, { IncomingMessage, Server, ServerResponse } from 'node:http';
import fs from 'fs';
import path from 'path';
import logger from '@/utils/troxorLogger';
import { handleApiRequest } from './apiHandler';
import { configManager } from '@/runtime/config';

/**
 * =============================================================================
 * AdminHttp
 * =============================================================================
 * Lightweight HTTP server for serving the admin web UI and static assets,
 * plus handling lightweight /api/* calls.
 *
 * - Redirects "/" → "/admin/"
 * - Serves any static files under ./public (admin UI, alerts, images, etc.)
 * - Handles /api/* requests through `handleApiRequest()`
 * - Supports `/admin` (no slash) → `/admin/index.html`
 * - Can be fully disabled via config:  adminHttp.enabled = false
 * =============================================================================
 */

export class AdminHttp {
  private server?: Server;
  private readonly enabled: boolean;

  constructor(private readonly port = 7090) {
    // Read enable flag from config (default = true)
    this.enabled = Boolean(configManager.get(cfg => cfg.adminHttp?.enabled ?? true));

    if (!this.enabled) {
      logger.info('[AdminHttp] Disabled via configuration (adminHttp.enabled=false)');
      return;
    }

    this.start();
  }

  /**
   * Starts the Admin HTTP server.
   */
  private start(): void {
    const publicDir = path.resolve(process.cwd(), 'public');

    this.server = http.createServer(async (req, res) => {
      if (!req.url) {
        return this.sendJson(res, 400, { error: 'Bad request: missing URL' });
      }

      // --- Redirect root (/) → /admin/ ------------------------------------
      if (req.url === '/') {
        res.writeHead(302, { Location: '/admin/' });
        res.end();
        return;
      }

      // --- API routes ------------------------------------------------------
      if (req.url.startsWith('/api/') || req.url.startsWith('/admin/api/')) {
        const body = await this.parseJsonBody(req);
        await handleApiRequest(req, res, body);
        return;
      }

      // --- Static file serving (admin, alerts, etc.) -----------------------
      this.serveStaticFile(publicDir, req, res);
    });

    this.server.listen(this.port, () => {
      logger.info(`[AdminHttp] Serving ./public (admin UI + static assets) on port ${this.port}`);
    });
  }

  /**
   * Gracefully shuts down the HTTP server.
   */
  public async shutdown(): Promise<void> {
    if (!this.server) {
      return;
    }
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    logger.info('[AdminHttp] Server closed');
  }

  /* -------------------------------------------------------------------------- */
  /*  Helpers                                                                   */
  /* -------------------------------------------------------------------------- */

  /** Parses JSON body for POST/PUT/PATCH requests. */
  private async parseJsonBody(req: IncomingMessage): Promise<unknown | undefined> {
    const method = req.method ?? 'GET';
    const contentType = req.headers['content-type'] ?? '';
    if (!['POST', 'PUT', 'PATCH'].includes(method)) {
      return undefined;
    }
    if (!contentType.toString().includes('application/json')) {
      return undefined;
    }

    return new Promise((resolve) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : undefined);
        } catch {
          resolve(undefined);
        }
      });
      req.on('error', () => resolve(undefined));
    });
  }

  /**
   * Serves any static file from ./public.
   * Includes admin UI, alerts, images, etc.
   */
  private serveStaticFile(publicDir: string, req: IncomingMessage, res: ServerResponse): void {
    const requestPath = req.url ?? '/';
    const normalized = path.normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, ''); // block traversal

    // Special case: "/admin" → serve index.html
    const isAdminRoot = normalized === '/admin' || normalized === '/admin/';
    const relativePath = isAdminRoot ? 'admin/index.html' : normalized.replace(/^\//, '');
    const filePath = path.join(publicDir, relativePath);

    logger.info(`[AdminHttp] Static filerequest ${filePath}`);

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        this.sendText(res, 404, 'Not Found');
        return;
      }

      const mime = this.getMimeType(filePath);
      fs.readFile(filePath, (readErr, data) => {
        if (readErr) {
          logger.warn(`[AdminHttp] Failed to read file ${filePath}: ${readErr.message}`);
          this.sendText(res, 500, 'Internal Server Error');
          return;
        }

        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
      });
    });
  }

  /** Maps file extension to MIME type. */
  private getMimeType(file: string): string {
    const ext = path.extname(file).toLowerCase();
    switch (ext) {
      case '.html': return 'text/html';
      case '.js': return 'text/javascript';
      case '.css': return 'text/css';
      case '.json': return 'application/json';
      case '.png': return 'image/png';
      case '.jpg':
      case '.jpeg': return 'image/jpeg';
      case '.gif': return 'image/gif';
      case '.svg': return 'image/svg+xml';
      case '.ico': return 'image/x-icon';
      case '.wav': return 'audio/wav';
      case '.mp3': return 'audio/mpeg';
      case '.ogg': return 'audio/ogg';
      default: return 'application/octet-stream';
    }
  }

  /** Sends a JSON response. */
  private sendJson(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  /** Sends a plain text response. */
  private sendText(res: ServerResponse, code: number, text: string): void {
    res.writeHead(code, { 'Content-Type': 'text/plain' });
    res.end(text);
  }
}