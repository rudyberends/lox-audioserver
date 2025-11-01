import WebSocket from 'ws';
import logger from '@/utils/troxorLogger';
import {
  CommandRequest,
  IncomingMessage,
  SuccessResultMessage,
  ErrorResultMessage,
  EventMessage,
  ServerInfoMessage,
  ConnectionState,
  EventCallback,
} from './types';

/**
 * -----------------------------------------------------------------------------
 * MusicAssistantClient
 * -----------------------------------------------------------------------------
 * Shared WebSocket RPC client for the Music Assistant backend.
 *
 * - Maintains one WebSocket connection per (ip:port)
 * - Supports multiple zones sharing the same connection
 * - Provides automatic reconnection and heartbeat ping
 * - Handles partial results and concurrent RPC requests
 * -----------------------------------------------------------------------------
 */
export default class MusicAssistantClient {
  private ws?: WebSocket;
  private state: ConnectionState = ConnectionState.DISCONNECTED;
  private nextMsgId = 0;

  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private partialBuffers: Record<number, any[]> = {};
  private eventHandlers = new Set<EventCallback>();

  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private lastPong: number = Date.now();
  private connecting = false;

  constructor(private readonly serverIp: string, private readonly serverPort: number) {}

  /* -------------------------------------------------------------------------- */
  /* Connection Lifecycle                                                       */
  /* -------------------------------------------------------------------------- */

  /** Establish a WebSocket connection (singleton per server). */
  async connect(): Promise<void> {
    if (this.state === ConnectionState.CONNECTED || this.connecting) {
      return;
    }

    this.connecting = true;
    const url = `ws://${this.serverIp}:${this.serverPort}/ws`;
    logger.debug(`[MusicAssistantClient] Connecting to ${url}...`);

    await new Promise<void>((resolve, reject) => {
      this.state = ConnectionState.CONNECTING;
      const ws = new WebSocket(url);
      let resolved = false;

      ws.on('open', () => {
        this.ws = ws;
        this.state = ConnectionState.CONNECTED;
        this.connecting = false;
        resolved = true;

        logger.info(`[MusicAssistantClient] Connected to ${url}`);

        // Heartbeat ping every 10s
        this.lastPong = Date.now();
        ws.on('pong', () => (this.lastPong = Date.now()));

        this.heartbeatTimer = setInterval(() => {
          if (!this.ws || this.state !== ConnectionState.CONNECTED) {
            return;
          }
          try {
            if (Date.now() - this.lastPong > 30000) {
              logger.warn(`[MusicAssistantClient] Heartbeat lost (${url}) → reconnect`);
              this.forceReconnect();
              return;
            }
            ws.ping();
          } catch {
            // ignore transient errors
          }
        }, 10000);

        resolve();
      });

      ws.on('close', () => {
        this.state = ConnectionState.DISCONNECTED;
        this.connecting = false;
        logger.warn(`[MusicAssistantClient] Connection closed (${url})`);
        this.scheduleReconnect();
        this.teardown();
      });

      ws.on('error', (err) => {
        this.connecting = false;
        logger.error(`[MusicAssistantClient] Connection error (${url}): ${err}`);
        if (!resolved) {
          reject(err);
        }
      });

      ws.on('message', (buf) => this.onMessage(buf));
    });
  }

  /** Tear down timers and reject all pending RPCs. */
  private teardown(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.pending.forEach((p) => p.reject(new Error('Connection closed')));
    this.pending.clear();
  }

  /** Trigger a controlled reconnect after random delay (jitter). */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    } // avoid duplicates
    const delay = Math.floor(2000 + Math.random() * 2000);
    logger.info(`[MusicAssistantClient] Reconnecting in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect().catch(() => {
        /* swallow — further retries will trigger automatically */
      });
    }, delay);
  }

  /** Immediately terminate the socket and reinitiate connection. */
  private forceReconnect(): void {
    try {
      this.ws?.terminate();
    } catch {
      /* ignore */
    }
    this.state = ConnectionState.DISCONNECTED;
    this.scheduleReconnect();
  }

  /** Gracefully shut down the client and clear all listeners. */
  cleanup(): void {
    this.teardown();
    try {
      this.ws?.terminate();
    } catch {
      /* ignore */
    }
    this.state = ConnectionState.DISCONNECTED;
  }

  /* -------------------------------------------------------------------------- */
  /* RPC + Event Dispatch                                                       */
  /* -------------------------------------------------------------------------- */

  /** Perform an RPC call against the Music Assistant API. */
  async rpc(command: string, args?: Record<string, any>): Promise<any> {
    if (!this.ws || this.state !== ConnectionState.CONNECTED) {
      logger.debug(`[MusicAssistantClient] Lazy connect before RPC → ${command}`);
      await this.connect();
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }

    const message_id = ++this.nextMsgId;
    const payload: CommandRequest = { command, message_id, args };

    return new Promise((resolve, reject) => {
      this.pending.set(message_id, { resolve, reject });
      try {
        this.ws!.send(JSON.stringify(payload));
      } catch (error) {
        this.pending.delete(message_id);
        reject(error);
      }
    });
  }

  /** Subscribe to raw Music Assistant events. Returns an unsubscribe callback. */
  onEvent(cb: EventCallback): () => void {
    this.eventHandlers.add(cb);
    return () => this.eventHandlers.delete(cb);
  }

  /** Dispose the client and all event subscriptions. */
  dispose(): void {
    this.cleanup();
    this.eventHandlers.clear();
  }

  /* -------------------------------------------------------------------------- */
  /* Message Parsing & Routing                                                  */
  /* -------------------------------------------------------------------------- */

  private onMessage(buf: WebSocket.RawData): void {
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    if ('server_version' in msg) {
      logger.debug(`[MusicAssistantClient] Server version: ${(msg as ServerInfoMessage).server_version}`);
      return;
    }

    if ('event' in msg) {
      this.dispatchEvent(msg as EventMessage);
      return;
    }

    const id = (msg as SuccessResultMessage | ErrorResultMessage).message_id;
    if (typeof id !== 'number') {
      return;
    }

    const waiter = this.pending.get(id);
    if (!waiter) {
      return;
    }

    if ('partial' in msg && (msg as SuccessResultMessage).partial) {
      const part = (msg as SuccessResultMessage).result ?? [];
      if (!this.partialBuffers[id]) {
        this.partialBuffers[id] = [];
      }
      this.partialBuffers[id].push(...part);
      return;
    }

    this.pending.delete(id);

    if ('error_code' in msg) {
      waiter.reject(
        new Error((msg as ErrorResultMessage).details || (msg as ErrorResultMessage).error_code),
      );
      return;
    }

    const ok = msg as SuccessResultMessage;
    if (this.partialBuffers[id]) {
      const merged = [...this.partialBuffers[id], ...(ok.result ?? [])];
      delete this.partialBuffers[id];
      waiter.resolve(merged);
    } else {
      waiter.resolve(ok.result);
    }
  }

  private dispatchEvent(evt: EventMessage): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(evt);
      } catch (error) {
        logger.error(`[MusicAssistantClient] Event callback error: ${error}`);
      }
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Singleton Accessors                                                        */
  /* -------------------------------------------------------------------------- */

  private static instances = new Map<string, MusicAssistantClient>();

  /** Returns a shared MusicAssistantClient per (ip, port). */
  static getInstance(ip: string, port = 8095): MusicAssistantClient {
    const key = `${ip}:${port}`;
    let instance = this.instances.get(key);
    if (!instance) {
      instance = new MusicAssistantClient(ip, port);
      this.instances.set(key, instance);
    }
    return instance;
  }

  /** Disposes all shared Music Assistant clients (used at global shutdown). */
  static disposeAll(): void {
    for (const [key, client] of this.instances.entries()) {
      client.dispose();
      this.instances.delete(key);
    }
  }
}