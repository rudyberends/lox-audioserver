import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { createLogger } from '@/shared/logging/logger';
import type { LineInIngestRegistry } from '@/adapters/inputs/linein/lineInIngestRegistry';
import { LINEIN_INGEST_HIGH_WATER_MARK } from '@/adapters/inputs/linein/lineInConstants';

const PATH_PREFIX = '/ingest/';

export class LineInIngestWebSocket {
  private readonly log = createLogger('Http', 'LineInIngestWs');
  private readonly wsServer = new WebSocketServer({ noServer: true });
  private readonly registry: LineInIngestRegistry;
  /**
   * Live ingest sockets by input id, so a transport command can be pushed the moment a client
   * presses a button instead of waiting for the bridge's next status poll. One per input: a second
   * connection for the same input replaces the first, matching the registry's own behaviour.
   */
  private readonly sockets = new Map<string, WebSocket>();

  constructor(registry: LineInIngestRegistry) {
    this.registry = registry;
    this.wsServer.on('connection', (socket, req) => {
      this.handleConnection(socket, req);
    });
  }

  /**
   * Push a command to the bridge serving this input.
   *
   * Returns false when no socket is connected, which is the caller's signal to fall back to the
   * polled queue -- a bridge on the TCP transport, or one that is momentarily reconnecting, still has
   * to receive the command eventually.
   */
  public sendCommand(inputId: string, command: string, args: string[] = []): boolean {
    const socket = this.sockets.get(inputId.trim());
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      socket.send(JSON.stringify({ command, args }));
      this.log.info('line-in command pushed', { inputId, command, args });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('line-in command push failed', { inputId, command, message });
      return false;
    }
  }

  public hasSocket(inputId: string): boolean {
    const socket = this.sockets.get(inputId.trim());
    return !!socket && socket.readyState === WebSocket.OPEN;
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

    const source = new PassThrough({ highWaterMark: LINEIN_INGEST_HIGH_WATER_MARK });
    this.registry.start(inputId, source);
    this.sockets.get(inputId)?.close(1012, 'replaced');
    this.sockets.set(inputId, socket);
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
      if (this.sockets.get(inputId) === socket) {
        this.sockets.delete(inputId);
      }
      this.log.info('line-in ingest ws ended', { inputId });
    });

    socket.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('line-in ingest ws error', { inputId, message });
      if (this.sockets.get(inputId) === socket) {
        this.sockets.delete(inputId);
      }
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
