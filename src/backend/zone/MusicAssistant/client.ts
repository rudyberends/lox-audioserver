import WebSocket from 'ws';
import logger from '../../../utils/troxorlogger';
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
 * Lightweight Music Assistant client encapsulating the raw WebSocket/RPC plumbing.
 * The backend class keeps high-level logic while this class deals with connection lifecycle.
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

  constructor(private readonly serverIp: string, private readonly serverPort: number) {}

  /** Connect to the Music Assistant websocket endpoint, installing heartbeat & reconnection hooks. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws://${this.serverIp}:${this.serverPort}/ws`;
      this.state = ConnectionState.CONNECTING;
      const ws = new WebSocket(url);

      let resolved = false;

      ws.on('open', () => {
        this.ws = ws;
        this.state = ConnectionState.CONNECTED;
        logger.info(`[MusicAssistant] Connected to ${url}`);
        resolved = true;

        // Heartbeat ping every 10s
        this.lastPong = Date.now();
        ws.on('pong', () => (this.lastPong = Date.now()));
        this.heartbeatTimer = setInterval(() => {
          try {
            if (Date.now() - this.lastPong > 30000) {
              logger.warn('[MusicAssistant] Heartbeat lost → reconnect');
              ws.terminate();
              return;
            }
            ws.ping();
          } catch {
            // ignore
          }
        }, 10000);

        resolve();
      });

      ws.on('close', () => {
        this.state = ConnectionState.DISCONNECTED;
        logger.warn('[MusicAssistant] Connection closed');
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

        this.pending.forEach((p) => p.reject(new Error('Connection closed')));
        this.pending.clear();

        const delay = Math.floor(2000 + Math.random() * 2000);
        this.reconnectTimer = setTimeout(() => {
          this.connect().catch(() => {
            // swallow; a later reconnect will try again
          });
        }, delay);
      });

      ws.on('error', (err) => {
        logger.error(`[MusicAssistant] Connection error: ${err}`);
        if (!resolved) reject(err);
      });

      ws.on('message', (buf) => this.onMessage(buf));
    });
  }

  /** Gracefully tear down the client. */
  cleanup(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.ws?.terminate();
    } catch {
      // ignore termination error
    }
    this.state = ConnectionState.DISCONNECTED;
    this.pending.forEach((p) => p.reject(new Error('Connection closed')));
    this.pending.clear();
  }

  /** Perform an RPC request against the Music Assistant backend. */
  rpc(command: string, args?: Record<string, any>): Promise<any> {
    if (!this.ws || this.state !== ConnectionState.CONNECTED || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected'));
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

  /** Subscribe to raw Music Assistant events. Returns an unsubscribe function. */
  onEvent(cb: EventCallback): () => void {
    this.eventHandlers.add(cb);
    return () => this.eventHandlers.delete(cb);
  }

  /** Remove timers and pending promises when destructed. */
  dispose(): void {
    this.cleanup();
    this.eventHandlers.clear();
  }

  private onMessage(buf: WebSocket.RawData) {
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    if ('server_version' in msg) {
      logger.info(`[MusicAssistant] Server version: ${(msg as ServerInfoMessage).server_version}`);
      return;
    }

    if ('event' in msg) {
      this.dispatchEvent(msg as EventMessage);
      return;
    }

    const id = (msg as SuccessResultMessage | ErrorResultMessage).message_id;
    if (typeof id !== 'number') return;
    const waiter = this.pending.get(id);
    if (!waiter) return;

    if ('partial' in msg && (msg as SuccessResultMessage).partial) {
      const part = (msg as SuccessResultMessage).result ?? [];
      if (!this.partialBuffers[id]) this.partialBuffers[id] = [];
      this.partialBuffers[id].push(...part);
      return;
    }

    this.pending.delete(id);

    if ('error_code' in msg) {
      waiter.reject(new Error((msg as ErrorResultMessage).details || (msg as ErrorResultMessage).error_code));
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

  private dispatchEvent(evt: EventMessage) {
    for (const handler of this.eventHandlers) {
      try {
        handler(evt);
      } catch (error) {
        logger.error(`[MusicAssistant] Event callback error: ${error}`);
      }
    }
  }
}
