import WebSocket from 'ws';
import { createLogger } from '@/shared/logging/logger';
import { bestEffort } from '@/shared/bestEffort';

type EventCallback = (evt: Record<string, unknown>) => void;

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  accumulate?: boolean;
  buffer?: any[];
}

/**
 * Minimal websocket RPC client for Music Assistant.
 */
export class MusicAssistantClient {
  private readonly log = createLogger('Content', 'MusicAssistantClient');
  private ws?: WebSocket;
  private connecting = false;
  private authenticated = false;
  private authInFlight: Promise<void> | null = null;
  private connectPromise: Promise<void> | null = null;
  private pending = new Map<string, PendingEntry>();
  private nextMsgId = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private lastPong = Date.now();
  private eventHandlers = new Set<EventCallback>();
  private reconnectAttempts = 0;
  private nextLogAt = 0;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly authToken?: string,
  ) {}

  public async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connecting && this.connectPromise) {
      await this.connectPromise;
      return;
    }
    if (this.connecting) return;
    this.connecting = true;

    const url = `ws://${this.host}:${this.port}/ws`;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      let resolved = false;

      ws.on('open', () => {
        this.ws = ws;
        this.connecting = false;
        this.authenticated = false;
        this.reconnectAttempts = 0;
        resolved = true;
        this.log.info('music assistant socket connected', { url });
        this.lastPong = Date.now();
        ws.on('pong', () => (this.lastPong = Date.now()));
        this.heartbeatTimer = setInterval(() => {
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
          try {
            if (Date.now() - this.lastPong > 30000) {
              this.log.warn('music assistant heartbeat lost, reconnecting', { url });
              this.forceReconnect();
              return;
            }
            ws.ping();
          } catch {
            /* ignore */
          }
        }, 10000);
        // Authenticate if token is provided and wait before resolving.
        if (this.authToken) {
          this.authInFlight = this.authenticate().catch((err) => {
            this.log.warn('music assistant auth failed', { message: err instanceof Error ? err.message : String(err) });
            throw err;
          });
          this.authInFlight
            .then(() => {
              resolve();
            })
            .catch((err) => {
              try {
                ws.terminate();
              } catch {
                /* ignore */
              }
              this.connecting = false;
              reject(err);
            })
            .finally(() => {
              this.authInFlight = null;
            });
        } else {
          resolve();
        }
      });

      ws.on('message', (buf) => this.handleMessage(buf));
      ws.on('close', () => {
        this.logConnectionIssue('music assistant socket closed', url, 'warn');
        this.teardown();
        if (!resolved) reject(new Error('socket closed'));
        this.scheduleReconnect();
      });
      ws.on('error', (err) => {
        this.logConnectionIssue('music assistant socket error', url, 'error', String(err));
        this.connecting = false;
        if (!resolved) reject(err);
      });
    });
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  public cleanup(): void {
    this.teardown();
    try {
      this.ws?.terminate();
    } catch {
      /* ignore */
    }
    this.ws = undefined;
    this.authenticated = false;
    this.authInFlight = null;
    this.connectPromise = null;
  }

  public onEvent(cb: EventCallback): () => void {
    this.eventHandlers.add(cb);
    return () => this.eventHandlers.delete(cb);
  }

  public async rpc(command: string, args?: Record<string, unknown>): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('music assistant socket not connected');
    }

    if (this.authToken && !this.authenticated && command !== 'auth' && command !== 'auth/login') {
      if (this.authInFlight) {
        // Best-effort wait; error is handled in the next authInFlight catch.
        await bestEffort(() => this.authInFlight as Promise<void>, { fallback: undefined });
      } else {
        this.authInFlight = this.authenticate();
      }
      await this.authInFlight.catch((err) => {
        this.log.warn('music assistant auth before rpc failed', { command, message: err instanceof Error ? err.message : String(err) });
      });
      this.authInFlight = null;
    }

    const messageId = ++this.nextMsgId;
    const payload: Record<string, unknown> = { command, message_id: messageId };
    if (args && Object.keys(args).length > 0) {
      payload.args = args;
    }

    return new Promise((resolve, reject) => {
      const key = String(messageId);
      const timeout = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`RPC timeout for ${command}`));
      }, 15000);

      this.pending.set(key, {
        resolve: (val) => {
          clearTimeout(timeout);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
        accumulate: true,
        buffer: [],
      });

      try {
        this.ws!.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(key);
        reject(err);
      }
    });
  }

  private handleMessage(buf: WebSocket.RawData): void {
    let msg: any;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (msg?.event === 'auth_required') {
      this.authenticated = false;
    }
    if (msg?.event === 'auth_ok') {
      this.authenticated = true;
    }
    const messageId = msg?.message_id;
    if (messageId && this.pending.has(String(messageId))) {
      const key = String(messageId);
      const entry = this.pending.get(key);
      if (!entry) return;

      if ('error_code' in msg) {
        this.pending.delete(key);
        const errorCode = msg.error_code ?? 'rpc error';
        const errorMessage =
          msg.details ??
          msg.error_message ??
          msg.message ??
          msg.error ??
          msg.reason ??
          '';
        const detail = errorMessage ? `${errorCode}: ${errorMessage}` : String(errorCode);
        entry.reject(new Error(detail));
        return;
      }

      // partial result handling
      if (entry.accumulate && msg?.partial) {
        if (!entry.buffer) entry.buffer = [];
        entry.buffer.push(...(msg.result ?? []));
        return;
      }

      this.pending.delete(key);
      if (entry.buffer && entry.buffer.length) {
        entry.resolve([...entry.buffer, ...(msg.result ?? [])]);
      } else {
        entry.resolve(msg.result ?? msg);
      }
      return;
    }

    if (msg?.event) {
      for (const cb of this.eventHandlers) {
        try {
          cb(msg);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private forceReconnect(): void {
    this.teardown();
    try {
      this.ws?.terminate();
    } catch {
      /* ignore */
    }
    this.scheduleReconnect();
  }

  private async authenticate(): Promise<void> {
    if (!this.authToken) return;
    try {
      await this.rpc('auth', { token: this.authToken, device_name: 'lox-audioserver' });
      this.authenticated = true;
    } catch (err) {
      this.authenticated = false;
      throw err;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const baseDelay = 2000;
    const maxDelay = 30000;
    const attempt = Math.min(this.reconnectAttempts, 6);
    const backoff = Math.min(maxDelay, baseDelay * 2 ** attempt);
    const delay = backoff + Math.round(Math.random() * 2000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      // Best-effort reconnect; failures keep retrying with backoff.
      void bestEffort(() => this.connect(), { fallback: undefined });
    }, delay);
  }

  private logConnectionIssue(
    message: string,
    url: string,
    level: 'warn' | 'error',
    detail?: string,
  ): void {
    const now = Date.now();
    const shouldLog = this.nextLogAt <= now;
    if (shouldLog) {
      this.nextLogAt = now + 15000;
      const payload = detail ? { url, message: detail } : { url };
      if (level === 'error') {
        this.log.error(message, payload);
      } else {
        this.log.warn(message, payload);
      }
    }
  }

  private teardown(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.pending.forEach((p) => p.reject(new Error('connection lost')));
    this.pending.clear();
    this.connecting = false;
  }
}
