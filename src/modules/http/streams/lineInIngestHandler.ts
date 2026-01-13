import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@/core/logging/logger';
import { getConfig } from '@/domain/config/configStore';
import { lineInIngestRegistry } from '@/modules/audio/inputs/linein/lineInIngestRegistry';

export class LineInIngestHandler {
  private readonly log = createLogger('Http', 'LineInIngest');

  public matches(pathname: string): boolean {
    return pathname.startsWith('/ingest/linein/');
  }

  public async handle(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method-not-allowed' }));
      return;
    }

    const rawId = pathname.slice('/ingest/linein/'.length);
    const inputId = decodeURIComponent(rawId || '').trim();
    const normalizedId = normalizeLineInInputId(inputId);
    if (!normalizedId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing-input-id' }));
      return;
    }

    lineInIngestRegistry.start(normalizedId, req);
    this.log.info('line-in ingest connected', { inputId: normalizedId });

    req.on('aborted', () => {
      this.log.info('line-in ingest aborted', { inputId: normalizedId });
    });

    req.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('line-in ingest request error', { inputId: normalizedId, message });
    });

    req.on('end', () => {
      res.writeHead(204);
      res.end();
      this.log.info('line-in ingest ended', { inputId: normalizedId });
    });
  }
}

function normalizeLineInInputId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes('#')) {
    return trimmed;
  }
  const match = trimmed.match(/^linein(\d+)$/i) ?? trimmed.match(/^(\d+)$/);
  if (!match) {
    return trimmed;
  }
  const index = Number(match[1] ?? '0');
  if (!Number.isFinite(index) || index <= 0) {
    return null;
  }
  const mac = getConfig()?.system?.audioserver?.macId?.trim();
  if (!mac) {
    return null;
  }
  return `${mac}#${1000000 + index}`;
}
