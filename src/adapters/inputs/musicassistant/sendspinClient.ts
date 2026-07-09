import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';
import WebSocket from 'ws';
import type { createLogger } from '@/shared/logging/logger';
import type { PlaybackMetadata } from '@/application/playback/audioManager';
import { extractSendspinMetadata } from './maStreamMediaHelpers';

export type StreamFormat = {
  codec: string;
  sampleRate: number;
  channels: number;
  bitDepth?: number;
};

export const SENDSPIN_SUPPORTED_CODECS = ['pcm'] as const;

export type SendspinClientHandlers = {
  start?: (zoneId: number, playerId: string, stream: PassThrough, fmt: StreamFormat) => void;
  stop?: (zoneId: number, playerId: string) => void;
  metadata?: (zoneId: number, playerId: string, metadata: PlaybackMetadata) => void;
  command?: (
    zoneId: number,
    playerId: string,
    payload: { command?: string; volume?: number; mute?: boolean },
  ) => void;
};

/**
 * WebSocket client for Music Assistant's `sendspin` builtin-player protocol.
 *
 * MA pushes a PCM stream and JSON control frames over a single ws connection.
 * This client handles auth, the hello/format handshake, periodic time/state
 * sync, audio chunk extraction, and metadata/command relay back into the
 * surrounding stream service via `handlers`.
 */
export class SendspinClient {
  private readonly volumeStep = 5;
  private ws: WebSocket | null = null;
  private ready = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private connectInFlight: Promise<boolean> | null = null;
  private allowReconnect = true;
  private stream: PassThrough | null = null;
  private streamFormat: StreamFormat | null = null;
  private streamGen = 0;
  private firstChunkLogged = false;
  private bytesSinceLog = 0;
  private lastLogTs = 0;
  private timeSyncTimer: NodeJS.Timeout | null = null;
  private stateTimer: NodeJS.Timeout | null = null;
  private volume = 100;
  private muted = false;
  private pendingStreamResolvers: Array<(value: { stream: PassThrough; format: StreamFormat } | null) => void> = [];
  private skippedBinarySlots = new Set<number>();
  private readonly supportedFormats = SENDSPIN_SUPPORTED_CODECS.flatMap((codec) => [
    { codec, sample_rate: 48000, channels: 2, bit_depth: 16 },
    { codec, sample_rate: 44100, channels: 2, bit_depth: 16 },
  ]);

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly token: string,
    private readonly playerId: string,
    private readonly zoneId: number,
    private readonly providerId: string,
    private readonly log: ReturnType<typeof createLogger>,
    private readonly onStream?: SendspinClientHandlers,
  ) {}

  public async connect(): Promise<boolean> {
    if (this.ready) return true;
    if (this.connectInFlight) return this.connectInFlight;
    this.allowReconnect = true;
    this.connectInFlight = this.connectWithSocket();
    try {
      return await this.connectInFlight;
    } finally {
      this.connectInFlight = null;
    }
  }

  private connectWithSocket(): Promise<boolean> {
    const url = `ws://${this.host}:${this.port}/sendspin`;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        this.log.warn('sendspin ws open failed', { url, message: err instanceof Error ? err.message : String(err) });
        this.scheduleReconnect('open-failed');
        return resolve(false);
      }
      const ws = this.ws;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.log.warn('sendspin auth timeout', { url, playerId: this.playerId });
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        this.scheduleReconnect('auth-timeout');
        resolve(false);
      }, 8000);
      ws.on('open', () => {
        try {
          ws.send(JSON.stringify({ type: 'auth', token: this.token, client_id: this.playerId }));
        } catch (err) {
          this.log.warn('sendspin auth send failed', { message: err instanceof Error ? err.message : String(err) });
        }
      });
      ws.on('message', (buf) => {
        if (settled) return;
        const msg = buf.toString();
        if (msg.includes('auth_ok') || msg.includes('hello') || msg.includes('player')) {
          this.ready = true;
          settled = true;
          clearTimeout(timeout);
          this.reconnectAttempts = 0;
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          try {
            this.bootstrapProtocol(ws);
          } catch (err) {
            this.log.warn('sendspin bootstrap failed', { message: err instanceof Error ? err.message : String(err) });
          }
          resolve(true);
          this.log.info('sendspin auth ok', { playerId: this.playerId });
        }
      });
      ws.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.log.warn('sendspin ws error', { message: err instanceof Error ? err.message : String(err) });
        this.scheduleReconnect('ws-error');
        resolve(false);
      });
      ws.on('close', () => {
        this.ready = false;
        this.scheduleReconnect('ws-close');
      });
    });
  }

  public close(): void {
    this.allowReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.ready = false;
    if (this.stream) {
      try {
        this.stream.destroy();
      } catch {
        /* ignore */
      }
    }
    this.stream = null;
    this.streamFormat = null;
    if (this.timeSyncTimer) clearInterval(this.timeSyncTimer);
    if (this.stateTimer) clearInterval(this.stateTimer);
    this.timeSyncTimer = null;
    this.stateTimer = null;
  }

  public getActiveStream(): { stream: PassThrough; format: StreamFormat } | null {
    if (this.stream && this.streamFormat) {
      return { stream: this.stream, format: this.streamFormat };
    }
    return null;
  }

  public isReady(): boolean {
    return this.ready;
  }

  public awaitStream(timeoutMs = 5000): Promise<{ stream: PassThrough; format: StreamFormat } | null> {
    const existing = this.getActiveStream();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.pendingStreamResolvers.indexOf(resolve);
        if (idx >= 0) this.pendingStreamResolvers.splice(idx, 1);
        this.log.warn('sendspin stream await timed out', { playerId: this.playerId, timeoutMs });
        resolve(null);
      }, timeoutMs);
      const wrapped = (value: { stream: PassThrough; format: StreamFormat } | null) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.pendingStreamResolvers.push(wrapped);
    });
  }

  private bootstrapProtocol(ws: WebSocket): void {
    ws.on('message', (data: WebSocket.RawData) => {
      if (typeof data === 'string' || data instanceof String) {
        const text = data.toString();
        try {
          const msg = JSON.parse(text);
          this.log.spam('sendspin ws message', { playerId: this.playerId, type: msg?.type, data: text.slice(0, 200) });
        } catch {
          this.log.spam('sendspin ws message', { playerId: this.playerId, data: text.slice(0, 200) });
        }
        this.handleJsonMessage(text);
        return;
      }
      if (data instanceof Buffer || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        const first = buf.find((b) => b > 0x20) ?? buf[0];
        if (first === 0x7b /* { */ || first === 0x5b /* [ */) {
          const text = buf.toString('utf8');
          try {
            const msg = JSON.parse(text);
            this.log.spam('sendspin ws json-as-binary', { playerId: this.playerId, type: msg?.type, data: text.slice(0, 200) });
          } catch {
            this.log.spam('sendspin ws json-as-binary', { playerId: this.playerId, data: text.slice(0, 200) });
          }
          this.handleJsonMessage(text);
          return;
        }
        this.handleBinaryMessage(buf);
      }
    });
    const hello = this.buildHelloMessage();
    try {
      ws.send(JSON.stringify(hello));
    } catch (err) {
      this.log.warn('sendspin hello failed', { message: err instanceof Error ? err.message : String(err) });
    }
    const sendTimeSync = () => {
      const nowUs = Math.floor(performance.now() * 1000);
      const timeMsg = { type: 'client/time', payload: { client_transmitted: nowUs } };
      try {
        ws.send(JSON.stringify(timeMsg));
      } catch {
        /* ignore */
      }
    };
    const sendState = () => {
      const stateMsg = {
        type: 'client/state',
        payload: { player: { state: 'synchronized', volume: this.volume, muted: this.muted } },
      };
      try {
        ws.send(JSON.stringify(stateMsg));
      } catch {
        /* ignore */
      }
    };
    sendTimeSync();
    sendState();
    this.timeSyncTimer = setInterval(() => sendTimeSync(), 2000);
    this.stateTimer = setInterval(() => sendState(), 5000);
  }

  private buildHelloMessage(): Record<string, unknown> {
    return {
      type: 'client/hello',
      payload: {
        client_id: this.playerId,
        name: this.playerId,
        version: 1,
        supported_roles: ['player@v1'],
        device_info: {
          product_name: 'Loxone AudioServer',
          manufacturer: 'Sonn Core',
          software_version: '3.0.1',
        },
        player_support: {
          supported_formats: this.supportedFormats,
          buffer_capacity: 1024 * 1024 * 5,
          supported_commands: ['volume', 'mute', 'play_pause'],
        },
      },
    };
  }

  private scheduleReconnect(reason: string): void {
    if (!this.allowReconnect) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(15000, 1000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts += 1;
    this.log.debug('sendspin reconnect scheduled', { playerId: this.playerId, delayMs: delay, reason });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private handleJsonMessage(raw: string): void {
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const msg = parsed as {
      type?: string;
      payload?: {
        player?: {
          command?: unknown;
          volume?: unknown;
          mute?: unknown;
          codec?: StreamFormat['codec'];
          sample_rate?: StreamFormat['sampleRate'];
          channels?: StreamFormat['channels'];
          bit_depth?: StreamFormat['bitDepth'];
        } & Record<string, unknown>;
      } & Record<string, unknown>;
    } & Record<string, unknown>;
    if (msg.type === 'server/hello') {
      this.log.info('sendspin server/hello', { playerId: this.playerId });
    }
    if (msg.type === 'server/command') {
      this.handleServerCommand(msg);
    }
    if (msg.type === 'server/time') {
      this.log.spam('sendspin server/time', { playerId: this.playerId });
      return;
    }
    if (msg.type === 'stream/request-format') {
      this.log.info('sendspin stream/request-format', { playerId: this.playerId });
      try {
        this.ws?.send(JSON.stringify(this.buildHelloMessage()));
      } catch (err) {
        this.log.warn('sendspin re-hello failed', { message: err instanceof Error ? err.message : String(err) });
      }
    }
    if (msg.type === 'stream/start' && msg.payload?.player) {
      const fmt: StreamFormat = {
        codec: msg.payload.player.codec as string,
        sampleRate: msg.payload.player.sample_rate as number,
        channels: msg.payload.player.channels as number,
        bitDepth: msg.payload.player.bit_depth,
      };
      this.activateStream(fmt, false);
      return;
    }
    if (msg.type === 'stream/clear' || msg.type === 'stream/end') {
      this.resetStreamState();
      this.streamFormat = null;
      this.log.info('sendspin stream cleared', { playerId: this.playerId, type: msg.type });
      return;
    }
    if (msg.type === 'metadata') {
      const meta = extractSendspinMetadata(msg, this.providerId);
      if (meta) this.onStream?.metadata?.(this.zoneId, this.playerId, meta);
      return;
    }
    const meta = extractSendspinMetadata(msg, this.providerId);
    if (meta) this.onStream?.metadata?.(this.zoneId, this.playerId, meta);
    this.log.debug('sendspin message', { playerId: this.playerId, type: msg.type });
  }

  private handleServerCommand(msg: any): void {
    const rawCmd = msg.payload?.player?.command;
    const vol = msg.payload?.player?.volume;
    const mute = msg.payload?.player?.mute;
    const normalizedCmd =
      typeof rawCmd === 'string' ? rawCmd.toLowerCase().replace(/[^a-z0-9]+/g, '_') : '';
    this.log.info('sendspin server command', { playerId: this.playerId, command: rawCmd, volume: vol, mute });
    const normalizedVolume =
      typeof vol === 'number'
        ? Math.max(0, Math.min(100, vol <= 1 ? Math.round(vol * 100) : Math.round(vol)))
        : null;
    if (normalizedVolume !== null) this.volume = normalizedVolume;
    if (typeof mute === 'boolean') this.muted = mute;
    if (normalizedVolume === null && normalizedCmd) {
      if (normalizedCmd === 'volume_up' || normalizedCmd === 'vol_up' || normalizedCmd === 'volumeup') {
        this.volume = Math.min(100, this.volume + this.volumeStep);
      } else if (
        normalizedCmd === 'volume_down' ||
        normalizedCmd === 'vol_down' ||
        normalizedCmd === 'volumedown' ||
        normalizedCmd === 'volume_decrease' ||
        normalizedCmd === 'volume_down_' ||
        normalizedCmd === 'volume_down__'
      ) {
        this.volume = Math.max(0, this.volume - this.volumeStep);
      } else if (normalizedCmd === 'volume_mute' || normalizedCmd === 'mute') {
        this.muted = true;
      } else if (normalizedCmd === 'volume_unmute' || normalizedCmd === 'unmute') {
        this.muted = false;
      }
    }
    try {
      this.onStream?.command?.(this.zoneId, this.playerId, {
        command: normalizedCmd || undefined,
        volume: this.volume,
        mute: typeof mute === 'boolean' ? mute : undefined,
      });
    } catch (err) {
      this.log.debug('sendspin command dispatch failed', {
        playerId: this.playerId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Allocate (or reuse) the PassThrough and notify pending awaiters. */
  private activateStream(fmt: StreamFormat, implicit: boolean): void {
    this.streamFormat = fmt;
    if (!this.stream || this.stream.destroyed || this.stream.writableEnded) {
      this.stream = new PassThrough();
    }
    this.streamGen += 1;
    this.firstChunkLogged = false;
    this.bytesSinceLog = 0;
    this.lastLogTs = 0;
    if (implicit) {
      this.log.warn('sendspin implicit stream/start (no format message)', {
        playerId: this.playerId,
        codec: fmt.codec,
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bitDepth: fmt.bitDepth,
      });
    } else {
      this.log.info('sendspin stream/start', {
        playerId: this.playerId,
        codec: fmt.codec,
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bitDepth: fmt.bitDepth,
      });
    }
    const toResolve = [...this.pendingStreamResolvers];
    this.pendingStreamResolvers = [];
    toResolve.forEach((resolver) => resolver({ stream: this.stream!, format: fmt }));
    if (!implicit) this.onStream?.start?.(this.zoneId, this.playerId, this.stream!, fmt);
  }

  private handleBinaryMessage(buf: Buffer): void {
    if (!this.streamFormat) {
      // Fallback: assume PCM 44.1k/16-bit stereo when audio arrives before a stream/start.
      this.activateStream({ codec: 'pcm', sampleRate: 44100, channels: 2, bitDepth: 16 }, true);
    }
    if (!this.stream) return;
    const payload = this.extractAudioPayload(buf);
    if (!payload?.length) return;
    this.stream.write(payload);
    this.bytesSinceLog += payload.length;
    if (!this.firstChunkLogged) {
      this.firstChunkLogged = true;
      this.log.info('sendspin first audio chunk', {
        playerId: this.playerId,
        bytes: payload.length,
        gen: this.streamGen,
        fmt: this.streamFormat,
      });
      this.lastLogTs = Date.now();
      return;
    }
    const now = Date.now();
    if (this.lastLogTs && now - this.lastLogTs >= 1000) {
      const bps = Math.round((this.bytesSinceLog / (now - this.lastLogTs)) * 1000);
      this.log.spam('sendspin audio throughput', { playerId: this.playerId, bytesPerSec: bps, gen: this.streamGen });
      this.bytesSinceLog = 0;
      this.lastLogTs = now;
    }
  }

  /** Sendspin audio chunks: [slot:uint8][timestamp:int64be][pcm payload...]. Slot 4 = audio. */
  private extractAudioPayload(buf: Buffer): Buffer | null {
    if (!buf || buf.length === 0) return null;
    if (buf.length >= 9) {
      const slot = buf.readUInt8(0);
      if (slot === 4) {
        const payload = buf.subarray(1 + 8);
        return payload.length ? payload : null;
      }
      if (!this.skippedBinarySlots.has(slot)) {
        this.skippedBinarySlots.add(slot);
        this.log.debug('sendspin binary frame ignored', { playerId: this.playerId, slot, bytes: buf.length });
      }
      return null;
    }
    return buf;
  }

  private resetStreamState(): void {
    this.firstChunkLogged = false;
    this.bytesSinceLog = 0;
    this.lastLogTs = 0;
  }
}
