import fsp from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { createLogger } from '@/shared/logging/logger';
import { getMimeType } from '@/adapters/http/utils/mimeTypes';

/**
 * Serves sanitized static files from the configured public directory.
 */
export class StaticFileHandler {
  private readonly log = createLogger('Http', 'Static');
  private readonly baseDir: string;

  constructor(publicDir: string) {
    this.baseDir = path.resolve(publicDir);
  }

  public async handle(pathname: string, res: ServerResponse): Promise<void> {
    const relative = pathname.replace(/^\//, '') || 'index.html';
    const resolved = this.resolve(relative);
    if (!resolved) {
      this.send(res, 403, 'Forbidden');
      return;
    }

    let target = resolved;
    let stats = await this.safeStat(target);

    if (stats?.isDirectory()) {
      target = path.join(target, 'index.html');
      stats = await this.safeStat(target);
    }

    if (!stats) {
      this.send(res, 404, 'Not Found');
      return;
    }

    try {
      const data = await fsp.readFile(target);
      res.writeHead(200, {
        'Content-Type': getMimeType(target),
        'Cache-Control': this.cacheControlFor(relative, target),
      });
      res.end(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error('static file read failed', { message });
      this.send(res, 500, 'Static file error');
    }
  }

  private resolve(relative: string): string | null {
    const absolute = path.resolve(this.baseDir, relative);
    const normalizedBase = this.baseDir.endsWith(path.sep)
      ? this.baseDir
      : `${this.baseDir}${path.sep}`;

    if (absolute !== this.baseDir && !absolute.startsWith(normalizedBase)) {
      this.log.warn('blocked static path traversal', { absolute });
      return null;
    }

    return absolute;
  }

  private async safeStat(filePath: string): Promise<Stats | null> {
    try {
      return await fsp.stat(filePath);
    } catch {
      return null;
    }
  }

  private cacheControlFor(relativePath: string, absolutePath: string): string {
    const normalized = relativePath.toLowerCase();
    if (absolutePath.endsWith('.html')) {
      return 'no-cache, no-store, must-revalidate';
    }
    if (normalized.includes('/assets/')) {
      return 'public, max-age=31536000, immutable';
    }
    return 'public, max-age=3600';
  }

  private send(res: ServerResponse, code: number, message: string): void {
    res.writeHead(code, { 'Content-Type': 'text/plain' });
    res.end(message);
  }
}
