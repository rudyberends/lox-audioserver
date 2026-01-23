import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@/shared/logging/logger';
import { getMimeType } from '@/adapters/http/utils/mimeTypes';

/**
 * Streams music files (with Range support) and lists directories under /music.
 */
export class MusicStreamingHandler {
  private readonly log = createLogger('Http', 'Music');
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
  }

  public matches(pathname: string): boolean {
    return pathname === '/music' || pathname.startsWith('/music/');
  }

  public async handle(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const relative = pathname.replace(/^\/music\/?/, '');
    const target = this.resolveTarget(relative);
    if (!target) {
      this.send(res, 403, 'Forbidden');
      return;
    }

    let stats: fs.Stats;
    try {
      stats = await fsp.stat(target);
    } catch {
      this.send(res, 404, 'Not Found');
      return;
    }

    if (stats.isDirectory()) {
      await this.sendDirectoryListing(target, relative, res);
      return;
    }

    await this.streamFile(req, res, target, stats.size);
  }

  private async sendDirectoryListing(
    directory: string,
    relative: string,
    res: ServerResponse,
  ): Promise<void> {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    const base = relative ? `/music/${relative.replace(/\/?$/, '/')}` : '/music/';

    const listing = entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'dir' : 'file',
      path: base + entry.name,
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(listing));
  }

  private async streamFile(
    req: IncomingMessage,
    res: ServerResponse,
    filePath: string,
    size: number,
  ): Promise<void> {
    const rangeHeader = req.headers.range;

    if (!rangeHeader) {
      res.writeHead(200, {
        'Content-Type': getMimeType(filePath),
        'Content-Length': size,
        'Accept-Ranges': 'bytes',
      });
      this.pipeStream(fs.createReadStream(filePath), res);
      return;
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match) {
      this.send(res, 416, 'Invalid Range');
      return;
    }

    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : size - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) {
      this.send(res, 416, 'Invalid Range');
      return;
    }

    res.writeHead(206, {
      'Content-Type': getMimeType(filePath),
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
    });

    this.pipeStream(fs.createReadStream(filePath, { start, end }), res);
  }

  private resolveTarget(relative: string): string | null {
    const candidate = path.resolve(this.baseDir, relative);
    const normalizedBase = this.baseDir.endsWith(path.sep)
      ? this.baseDir
      : `${this.baseDir}${path.sep}`;

    if (candidate !== this.baseDir && !candidate.startsWith(normalizedBase)) {
      this.log.warn('blocked music path traversal', { candidate });
      return null;
    }

    return candidate;
  }

  private pipeStream(stream: fs.ReadStream, res: ServerResponse): void {
    stream.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error('music stream error', { message });
      if (!res.headersSent) {
        this.send(res, 500, 'Streaming error');
      } else {
        res.destroy(error as Error);
      }
    });
    stream.pipe(res);
  }

  private send(res: ServerResponse, status: number, text: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(text);
  }
}
