import net from 'node:net';
import { PassThrough } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import type { LineInIngestRegistry } from '@/adapters/inputs/linein/lineInIngestRegistry';

const DEFAULT_TCP_PORT = 7080;
const MAX_ID_BYTES = 256;
const ID_TIMEOUT_MS = 2000;

export class LineInIngestTcp {
  private readonly log = createLogger('Http', 'LineInIngestTcp');
  private server?: net.Server;

  constructor(private readonly registry: LineInIngestRegistry) {}

  public async start(): Promise<void> {
    if (this.server) {
      return;
    }
    const port = this.resolvePort();
    const host = this.resolveHost();
    this.server = net.createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!
        .listen(port, host, () => {
          this.log.info('line-in ingest tcp listening', { host, port });
          resolve();
        })
        .on('error', reject);
    });
  }

  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handleConnection(socket: net.Socket): void {
    const defaultId = this.resolveDefaultId();
    if (defaultId) {
      this.pipeSocket(socket, defaultId, Buffer.alloc(0));
      return;
    }

    let buffer = Buffer.alloc(0);
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        socket.destroy();
      }
    }, ID_TIMEOUT_MS);

    socket.on('data', (chunk) => {
      if (resolved) {
        return;
      }
      const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > MAX_ID_BYTES) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) {
        return;
      }
      const idRaw = buffer.slice(0, newline).toString('utf8').trim();
      const inputId = normalizeLineInInputId(idRaw);
      const remainder = buffer.slice(newline + 1);
      resolved = true;
      clearTimeout(timeout);
      if (!inputId) {
        socket.destroy();
        return;
      }
      this.pipeSocket(socket, inputId, remainder);
    });

    socket.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('line-in ingest tcp socket error', { message });
    });
  }

  private pipeSocket(socket: net.Socket, inputId: string, initial: Buffer): void {
    const source = new PassThrough({ highWaterMark: 1024 * 64 });
    this.registry.start(inputId, source);
    this.log.info('line-in ingest tcp connected', { inputId });

    if (initial.length) {
      source.write(initial);
    }

    socket.on('data', (chunk) => {
      if (!chunk?.length) return;
      const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      source.write(data);
    });

    socket.on('close', () => {
      source.end();
      this.log.info('line-in ingest tcp ended', { inputId });
    });

    socket.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('line-in ingest tcp error', { inputId, message });
      source.end();
    });
  }

  private resolvePort(): number {
    return DEFAULT_TCP_PORT;
  }

  private resolveHost(): string {
    return '0.0.0.0';
  }

  private resolveDefaultId(): string | null {
    return null;
  }
}

function normalizeLineInInputId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}
