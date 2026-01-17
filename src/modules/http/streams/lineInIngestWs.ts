import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { createLogger } from '@/core/logging/logger';
import { lineInIngestRegistry } from '@/modules/audio/inputs/linein/lineInIngestRegistry';

const PATH_PREFIX = '/ingest/';

export class LineInIngestWebSocket {
  private readonly log = createLogger('Http', 'LineInIngestWs');
  private readonly wsServer = new WebSocketServer({ noServer: true });

  constructor() {
    this.wsServer.on('connection', (socket, req) => {
      this.handleConnection(socket, req);
    });
  }

  public handleUpgrade(request: IncomingMessage, socket: any, head: Buffer): boolean {
    const inputId = this.resolveInputId(request.url);
    if (!inputId) {
      return false;
    }
    this.wsServer.handleUpgrade(request, socket, head, (ws) => {
      this.wsServer.emit('connection', ws, request);
    });
    return true;
  }

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const inputId = this.resolveInputId(request.url);
    if (!inputId) {
      socket.close(1008, 'missing-input-id');
      return;
    }

    const source = new PassThrough({ highWaterMark: 1024 * 64 });
    lineInIngestRegistry.start(inputId, source);
    this.log.info('line-in ingest ws connected', { inputId });

    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        return;
      }
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      source.write(chunk);
    });

    socket.on('close', () => {
      source.end();
      this.log.info('line-in ingest ws ended', { inputId });
    });

    socket.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('line-in ingest ws error', { inputId, message });
      source.end();
    });
  }

  private resolveInputId(url?: string): string | null {
    const rawPath = (url ?? '').split('?')[0] || '/';
    if (!rawPath.startsWith(PATH_PREFIX)) {
      return null;
    }
    const rawId = rawPath.slice(PATH_PREFIX.length);
    const inputId = decodeURIComponent(rawId || '').trim();
    const normalizedId = normalizeLineInInputId(inputId);
    return normalizedId || null;
  }
}

function normalizeLineInInputId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}
