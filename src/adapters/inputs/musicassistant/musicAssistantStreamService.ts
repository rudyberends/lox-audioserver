import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { ZoneConfig } from '@/domain/config/types';
import type { PlaybackSource, PlaybackMetadata } from '@/application/playback/audioManager';
import type { QueueItem } from '@/application/zones/zoneManager';
import WebSocket from 'ws';
import { performance } from 'node:perf_hooks';
import { MusicAssistantApi } from '@/shared/musicassistant/musicAssistantApi';
import { decodeAudiopath, encodeAudiopath } from '@/domain/loxone/audiopath';
import { PassThrough } from 'node:stream';
import { generateQueueId } from '@/application/zones/helpers/queueHelpers';

type StreamEntry = {
  playerId: string;
};

type MusicAssistantPlaybackResult = {
  playbackSource: PlaybackSource | null;
  outputOnly?: boolean;
};

export type MusicAssistantPlayer = {
  player_id?: string;
  id?: string;
  name?: string;
};

type OutputHandlers = {
  onQueueUpdate: (zoneId: number, items: QueueItem[], currentIndex: number) => void;
  onOutputError: (zoneId: number, reason?: string) => void;
};

type StreamFormat = {
  codec: string;
  sampleRate: number;
  channels: number;
  bitDepth?: number;
};

const SUPPORTED_CODECS = ['pcm'] as const;

function toPlayerId(zoneName: string, fallbackId: number): string {
  const normalized = zoneName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `lox-${normalized || fallbackId}`;
}

class SendspinClient {
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
  private lastStreamEndedAt = 0;
  private timeSyncTimer: NodeJS.Timeout | null = null;
  private stateTimer: NodeJS.Timeout | null = null;
  private volume = 100;
  private muted = false;
  private pendingStreamResolvers: Array<(value: { stream: PassThrough; format: StreamFormat } | null) => void> = [];
  private skippedBinarySlots = new Set<number>();
  private readonly supportedFormats = SUPPORTED_CODECS.flatMap((codec) => [
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
  private readonly onStream?: {
      start?: (zoneId: number, playerId: string, stream: PassThrough, fmt: StreamFormat) => void;
      stop?: (zoneId: number, playerId: string) => void;
      metadata?: (zoneId: number, playerId: string, metadata: PlaybackMetadata) => void;
      command?: (
        zoneId: number,
        playerId: string,
        payload: { command?: string; volume?: number; mute?: boolean },
      ) => void;
    },
  ) {}

  public async connect(): Promise<boolean> {
    if (this.ready) {
      return true;
    }
    if (this.connectInFlight) {
      return this.connectInFlight;
    }
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
        if (settled) {
          return;
        }
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
        if (settled) {
          return;
        }
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
        if (settled) {
          return;
        }
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
    if (this.timeSyncTimer) {
      clearInterval(this.timeSyncTimer);
    }
    if (this.stateTimer) {
      clearInterval(this.stateTimer);
    }
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
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.pendingStreamResolvers.indexOf(resolve);
        if (idx >= 0) {
          this.pendingStreamResolvers.splice(idx, 1);
        }
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
      // Wire-tap messages; downgrade server/time to spam.
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
        // Some servers send JSON as binary frames; detect and handle.
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
        return;
      }
    });
    // Send client/hello
    const hello = {
      type: 'client/hello',
      payload: {
        client_id: this.playerId,
        name: this.playerId,
        version: 1,
        supported_roles: ['player@v1'],
        device_info: {
          product_name: 'Loxone AudioServer',
          manufacturer: 'Lox-audioserver',
          software_version: '3.0.1',
        },
        player_support: {
          supported_formats: this.supportedFormats,
          buffer_capacity: 1024 * 1024 * 5,
          supported_commands: ['volume', 'mute'],
        },
      },
    };
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
    // Immediate syncs after hello.
    sendTimeSync();
    sendState();
    // Periodic time sync/state (lightweight).
    this.timeSyncTimer = setInterval(() => sendTimeSync(), 2000);
    this.stateTimer = setInterval(() => sendState(), 5000);
  }

  private scheduleReconnect(reason: string): void {
    if (!this.allowReconnect) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }
    const delay = Math.min(15000, 1000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts += 1;
    this.log.debug('sendspin reconnect scheduled', { playerId: this.playerId, delayMs: delay, reason });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private handleJsonMessage(raw: string): void {
    if (!raw) {
      return;
    }
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'server/hello') {
      this.log.info('sendspin server/hello', { playerId: this.playerId });
    }
    if (msg.type === 'server/command') {
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
      if (normalizedVolume !== null) {
        this.volume = normalizedVolume;
      }
      if (typeof mute === 'boolean') {
        this.muted = mute;
      }
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
    if (msg.type === 'server/time') {
      this.log.spam('sendspin server/time', { playerId: this.playerId });
      return;
    }
    if (msg.type === 'stream/request-format') {
      this.log.info('sendspin stream/request-format', { playerId: this.playerId });
      // Re-advertise supported formats.
      const hello = {
        type: 'client/hello',
        payload: {
          client_id: this.playerId,
          name: this.playerId,
          version: 1,
          supported_roles: ['player@v1'],
          device_info: {
            product_name: 'Loxone AudioServer',
            manufacturer: 'Lox-audioserver',
            software_version: '3.0.1',
          },
          player_support: {
            supported_formats: this.supportedFormats,
            buffer_capacity: 1024 * 1024 * 5,
            supported_commands: ['volume', 'mute'],
          },
        },
      };
      try {
        this.ws?.send(JSON.stringify(hello));
      } catch (err) {
        this.log.warn('sendspin re-hello failed', { message: err instanceof Error ? err.message : String(err) });
      }
    }
    if (msg.type === 'stream/start' && msg.payload?.player) {
      const fmt: StreamFormat = {
        codec: msg.payload.player.codec,
        sampleRate: msg.payload.player.sample_rate,
        channels: msg.payload.player.channels,
        bitDepth: msg.payload.player.bit_depth,
      };
      this.streamFormat = fmt;
      // Keep the PassThrough stable so downstream consumers (audio engine) stay attached across stream restarts.
      if (!this.stream || this.stream.destroyed || this.stream.writableEnded) {
        this.stream = new PassThrough();
      }
      this.streamGen += 1;
      this.firstChunkLogged = false;
      this.bytesSinceLog = 0;
      this.lastLogTs = 0;
      this.log.info('sendspin stream/start', {
        playerId: this.playerId,
        codec: fmt.codec,
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bitDepth: fmt.bitDepth,
      });
      this.lastStreamEndedAt = 0;
      const toResolve = [...this.pendingStreamResolvers];
      this.pendingStreamResolvers = [];
      toResolve.forEach((resolver) => resolver({ stream: this.stream!, format: fmt }));
      this.onStream?.start?.(this.zoneId, this.playerId, this.stream!, fmt);
      return;
    }
    if (msg.type === 'stream/clear' || msg.type === 'stream/end') {
      // Reset stream state but keep the PassThrough alive so downstream consumers stay attached.
      this.resetStreamState();
      this.streamFormat = null;
      this.lastStreamEndedAt = Date.now();
      this.log.info('sendspin stream cleared', { playerId: this.playerId, type: msg.type });
      // Do not stop on stream/end; rely on MA state/STOP for session teardown.
      return;
    }
    if (msg.type === 'metadata') {
      const meta = this.extractSendspinMetadata(msg);
      if (meta) {
        this.onStream?.metadata?.(this.zoneId, this.playerId, meta);
      }
      return;
    }
    const meta = this.extractSendspinMetadata(msg);
    if (meta) {
      this.onStream?.metadata?.(this.zoneId, this.playerId, meta);
    }
    this.log.debug('sendspin message', { playerId: this.playerId, type: msg.type });
  }

  private handleBinaryMessage(buf: Buffer): void {
    if (!this.streamFormat) {
      // Fallback: if we receive audio before a stream/start, assume PCM 44.1k/16-bit stereo.
      const fmt: StreamFormat = { codec: 'pcm', sampleRate: 44100, channels: 2, bitDepth: 16 };
      this.streamFormat = fmt;
      if (!this.stream || this.stream.destroyed || this.stream.writableEnded) {
        this.stream = new PassThrough();
      }
      this.streamGen += 1;
      this.firstChunkLogged = false;
      this.bytesSinceLog = 0;
      this.lastLogTs = 0;
      this.log.warn('sendspin implicit stream/start (no format message)', {
        playerId: this.playerId,
        codec: fmt.codec,
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bitDepth: fmt.bitDepth,
      });
      const toResolve = [...this.pendingStreamResolvers];
      this.pendingStreamResolvers = [];
      toResolve.forEach((resolver) => resolver({ stream: this.stream!, format: fmt }));
    }
    if (!this.stream) {
      return;
    }
    const payload = this.extractAudioPayload(buf);
    if (!payload?.length) {
      return;
    }
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

  // Sendspin audio chunks are framed as: [slot:uint8][timestamp:int64be][pcm payload...]
  private extractAudioPayload(buf: Buffer): Buffer | null {
    if (!buf || buf.length === 0) {
      return null;
    }
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

  private parseMaMediaRef(mediaId: string): { type: string | null; id: string | null; provider: string | null } {
    if (!mediaId) {
      return { type: null, id: null, provider: null };
    }
    if (mediaId.includes('://')) {
      const [scheme, restRaw] = mediaId.split('://');
      const rest = restRaw || '';
      const [maybeType, ...restParts] = rest.split('/');
      const type = maybeType || null;
      const id = restParts.join('/') || null;
      return { type, id, provider: scheme || null };
    }
    const parts = mediaId.split(':');
    if (parts.length >= 3) {
      const provider = parts[0] || null;
      const type = parts[1] || null;
      const id = parts.slice(2).join(':') || null;
      return { type, id, provider };
    }
    return { type: null, id: mediaId || null, provider: null };
  }

  private toLoxoneAudiopath(mediaId: string | undefined, typeHint = 'track'): string | undefined {
    if (!mediaId) {
      return undefined;
    }
    const ref = this.parseMaMediaRef(mediaId);
    const type = ref.type || typeHint || 'track';
    const raw = ref.id && ref.provider ? `${ref.provider}://${type}/${ref.id}` : mediaId;
    return encodeAudiopath(raw, type, this.providerId);
  }

  private extractCover(obj: any): string {
    const images = obj?.metadata?.images || obj?.images || obj?.covers || obj?.artwork;
    if (Array.isArray(images) && images.length) {
      const img = images.find((i: any) => i?.path || i?.url || i?.link) || images[0];
      const path = img?.path || img?.url || img?.link;
      if (typeof path === 'string') {
        return this.resizeCover(path);
      }
    }
    if (typeof obj?.image === 'string') {
      return this.resizeCover(obj.image);
    }
    if (typeof obj?.cover === 'string') {
      return this.resizeCover(obj.cover);
    }
    if (typeof obj?.thumbnail === 'string') {
      return this.resizeCover(obj.thumbnail);
    }
    return '';
  }

  private resizeCover(url: string): string {
    if (!url) {
      return '';
    }
    try {
      const parsed = new URL(url);
      if (parsed.pathname.includes('imageproxy') && !parsed.searchParams.has('size')) {
        parsed.searchParams.set('size', '256');
        return parsed.toString();
      }
      if (parsed.hostname.includes('mzstatic.com')) {
        parsed.pathname = parsed.pathname.replace(/\/(\d{2,5})x\1bb\.jpg/i, '/256x256bb.jpg');
        return parsed.toString();
      }
    } catch {
      /* ignore */
    }
    return url;
  }

  private extractSendspinMetadata(msg: any): PlaybackMetadata | null {
    const payload = msg?.payload ?? msg;
    if (!payload) {
      return null;
    }
    const src =
      payload.metadata ||
      payload.player?.metadata ||
      payload.media ||
      payload.track ||
      payload.item ||
      payload;
    const title =
      src?.title ||
      src?.name ||
      src?.track ||
      src?.media_title ||
      src?.track_name ||
      payload?.title ||
      payload?.name ||
      '';
    const artist =
      src?.artist ||
      src?.artists?.[0]?.name ||
      src?.album_artist ||
      payload?.artist ||
      '';
    const album = src?.album?.name || src?.album || payload?.album || '';
    const cover = this.extractCover(src);
    const duration =
      typeof src?.duration === 'number' && src.duration > 0
        ? Math.round(src.duration)
        : typeof payload?.duration === 'number' && payload.duration > 0
          ? Math.round(payload.duration)
          : undefined;
    const rawAudiopath =
      typeof src?.media_id === 'string'
        ? src.media_id
        : typeof src?.uri === 'string'
          ? src.uri
          : undefined;
    const audiopath = this.toLoxoneAudiopath(rawAudiopath, src?.type || payload?.type || 'track');
    if (!title && !artist && !album && !cover && !audiopath && !duration) {
      return null;
    }
    const meta: PlaybackMetadata = {
      title: title || '',
      artist: artist || '',
      album: album || '',
    };
    if (cover) {
      meta.coverurl = cover;
    }
    if (audiopath) {
      meta.audiopath = audiopath;
    }
    if (duration) {
      meta.duration = duration;
    }
    return meta;
  }
}

export class MusicAssistantStreamService {
  private readonly log = createLogger('Input', 'MAplayer');
  private host: string | null = null;
  private port = 8095;
  private apiKey?: string;
  private registerAll = true;
  private api: MusicAssistantApi | null = null;
  private lastConnectionStatus:
    | { ok: boolean; checkedAt: number; message?: string; host?: string; port?: number }
    | null = null;
  private streams = new Map<number, StreamEntry>();
  private playerToZone = new Map<string, number>();
  private zonePlayers = new Map<number, string>();
  private subs = new Map<number, () => void>();
  private queueFetches = new Map<number, number>();
  private keepAliveTimers = new Map<number, NodeJS.Timeout>();
  private playingState = new Map<number, boolean>();
  private sendspinClients = new Map<number, SendspinClient>();
  private lastMetadata = new Map<number, PlaybackMetadata>();
  private lastMetadataKeys = new Map<number, string[]>();
  private lastStreamStartAt = new Map<number, number>();
  private lastVolume = new Map<number, number>();
  private lastPauseAt = new Map<number, number>();
  private switchAwayHandlers: {
    onSwitchAway?: (zoneId: number) => void;
  } = {};
  private lastPlayIntentAt = new Map<number, number>();
  // Tracks in-flight serviceplay requests so sendspin doesn't double-start playback.
  private pendingStreamRequests = new Map<number, number>();
  private streamRequestSeq = 0;
  private providerId = 'spotify@musicassistant';
  private inputHandlers: {
    startPlayback?: (zoneId: number, label: string, source: PlaybackSource, metadata?: PlaybackMetadata) => void;
    stopPlayback?: (zoneId: number) => void;
    updateVolume?: (zoneId: number, volume: number) => void;
    updateMetadata?: (zoneId: number, metadata: Partial<PlaybackMetadata>) => void;
    updateTiming?: (zoneId: number, elapsed: number, duration: number) => void;
  } | null = null;
  private readonly configPort: ConfigPort;

  constructor(private readonly outputHandlers: OutputHandlers, configPort: ConfigPort) {
    this.configPort = configPort;
  }

  private get config(): ConfigPort {
    return this.configPort;
  }

  public setInputHandlers(handlers: typeof this.inputHandlers): void {
    this.inputHandlers = handlers;
  }

  public setSwitchAwayHandlers(handlers: typeof this.switchAwayHandlers): void {
    this.switchAwayHandlers = handlers;
  }

  public async switchAway(zoneId: number): Promise<void> {
    const api = this.getApi();
    if (!api) {
      return;
    }
    const playerId =
      this.zonePlayers.get(zoneId) ??
      this.streams.get(zoneId)?.playerId ??
      Array.from(this.playerToZone.entries()).find(([, zid]) => zid === zoneId)?.[0] ??
      '';
    if (!playerId) {
      return;
    }
    try {
      this.log.info('music assistant switch away: stopping and clearing queue', { zoneId, playerId });
      await api.playerCommand(playerId, 'stop');
      try {
        await api.clearQueue(playerId);
      } catch (err) {
        this.log.debug('music assistant clear queue failed (ignored)', {
          zoneId,
          playerId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('music assistant switch away failed', { zoneId, playerId, message });
    }
  }

  public getProviderId(): string {
    return this.providerId;
  }

  public getLastConnectionStatus():
    | { ok: boolean; checkedAt: number; message?: string; host?: string; port?: number }
    | null {
    return this.lastConnectionStatus;
  }

  public async testConnection(): Promise<{
    ok: boolean;
    checkedAt: number;
    message?: string;
    host?: string;
    port?: number;
  }> {
    const checkedAt = Date.now();
    if (!this.host) {
      const status = {
        ok: false,
        checkedAt,
        message: 'music assistant bridge not configured',
      };
      this.lastConnectionStatus = status;
      return status;
    }
    const api = this.getApi();
    if (!api) {
      const status = {
        ok: false,
        checkedAt,
        message: 'music assistant bridge not configured',
        host: this.host ?? undefined,
        port: this.port,
      };
      this.lastConnectionStatus = status;
      return status;
    }
    try {
      await api.connect();
      const status = { ok: true, checkedAt, host: this.host ?? undefined, port: this.port };
      this.lastConnectionStatus = status;
      return status;
    } catch (err) {
      const status = {
        ok: false,
        checkedAt,
        message: err instanceof Error ? err.message : String(err),
        host: this.host ?? undefined,
        port: this.port,
      };
      this.lastConnectionStatus = status;
      return status;
    }
  }

  public configureFromConfig(): void {
    // Clean up previous config if host changes.
    if (this.api) {
      this.api.release();
      this.api = null;
    }
    // Close sendspin clients when host changes/disabled.
    for (const client of this.sendspinClients.values()) {
      client.close();
    }
    this.sendspinClients.clear();
    this.playerToZone.clear();
    this.lastStreamStartAt.clear();
    this.pendingStreamRequests.clear();
    try {
      const cfg = this.config.getConfig();
      const bridge = (cfg.content?.spotify?.bridges ?? []).find(
        (b) => b?.provider?.toLowerCase() === 'musicassistant' || b?.id?.toLowerCase() === 'musicassistant',
      );
      if (!bridge || bridge.enabled === false) {
        this.host = null;
        this.streams.clear();
        return;
      }
      this.providerId = bridge.id && bridge.id.trim() ? `spotify@${bridge.id.trim()}` : 'spotify@musicassistant';
      this.host = (bridge.host || '').trim() || '127.0.0.1';
      this.port = typeof bridge.port === 'number' && bridge.port > 0 ? bridge.port : 8095;
      this.apiKey = typeof bridge.apiKey === 'string' && bridge.apiKey.trim() ? bridge.apiKey.trim() : undefined;
      this.registerAll = bridge.registerAll !== false;
      this.api = MusicAssistantApi.acquire(this.host, this.port, this.apiKey);
    } catch {
      this.host = null;
    }
  }

  public async registerZones(zones: ZoneConfig[]): Promise<void> {
    if (!this.registerAll) {
      return;
    }
    if (!this.host) {
      return;
    }
    await Promise.all(
      zones
        .filter(
          (zone) =>
            zone.inputs?.musicassistant?.enabled !== false &&
            zone.inputs?.musicassistant?.offload !== true,
        )
        .map(async (zone) => {
          try {
            await this.registerZone(zone.id, zone.name, zone);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log.warn('failed to register MA builtin player for zone', { zoneId: zone.id, message });
          }
        }),
    );
  }

  private resolveZoneConfig(zoneId: number): ZoneConfig | undefined {
    try {
      const cfg = this.config.getConfig();
      return (cfg.zones ?? []).find((zone) => zone.id === zoneId) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private resolveZoneName(zoneId: number): string {
    return this.resolveZoneConfig(zoneId)?.name || `zone-${zoneId}`;
  }

  public async listPlayers(): Promise<MusicAssistantPlayer[]> {
    const api = this.getApi();
    if (!api || !this.host) {
      return [];
    }
    try {
      const players = await api.getAllPlayers();
      return Array.isArray(players) ? players : [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('music assistant list players failed', { message });
      return [];
    }
  }

  public async registerZone(zoneId: number, zoneName: string, zoneConfig?: ZoneConfig): Promise<StreamEntry | null> {
    if (!this.host) {
      return null;
    }
    const effectiveConfig = zoneConfig ?? this.resolveZoneConfig(zoneId);
    if (effectiveConfig?.inputs?.musicassistant?.enabled === false) {
      return null;
    }
    if (effectiveConfig?.inputs?.musicassistant?.offload) {
      return null;
    }
    const playerId = this.streams.get(zoneId)?.playerId ?? toPlayerId(zoneName, zoneId);
    const existingEntry = this.streams.get(zoneId);

    // Try sendspin registration (mirrors MA web player). We might need to recreate the client after a config reload
    // even if a stream entry already exists.
    if (this.apiKey && !this.sendspinClients.has(zoneId)) {
      const sendspinClient = new SendspinClient(
        this.host,
        this.port,
        this.apiKey,
        playerId,
        zoneId,
        this.providerId,
        this.log,
        {
          start: (zId, pId, stream, fmt) => this.handleInputStreamStart(zId, pId, stream, fmt),
          stop: (zId, pId) => this.handleInputStreamStop(zId, pId),
          metadata: (zId, pId, meta) => this.handleInputMetadata(zId, pId, meta),
          command: (zId, pId, payload) => this.handleInputCommand(zId, pId, payload),
        },
      );
      this.sendspinClients.set(zoneId, sendspinClient);
      this.playerToZone.set(playerId, zoneId);
      try {
        const ok = await sendspinClient.connect();
        if (ok) {
          this.log.info('sendspin player registered', { zoneId, playerId });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn('sendspin registration failed', { zoneId, message });
      }
    }

    const api = this.getApi();
    // We no longer rely on builtin_player/register; still set up subscription to catch PLAY_MEDIA events.
    try {
      await api?.connect();
      if (api) {
        this.ensureSubscription(zoneId, playerId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('music assistant subscription setup failed', { zoneId, message });
    }

    if (existingEntry) {
      // Ensure keepalive/subscription/sendspin are refreshed even when the stream entry already existed.
      this.streams.set(zoneId, existingEntry);
      this.startKeepAlive(zoneId, playerId);
      return existingEntry;
    }

    const entry: StreamEntry = { playerId };
    this.streams.set(zoneId, entry);
    this.startKeepAlive(zoneId, playerId);
    return entry;
  }

  public getPlaybackSource(zoneId: number): PlaybackSource | null {
    if (!this.host) {
      return null;
    }
    const zoneConfig = this.resolveZoneConfig(zoneId);
    if (zoneConfig?.inputs?.musicassistant?.enabled === false) {
      return null;
    }
    if (zoneConfig?.inputs?.musicassistant?.offload) {
      return null;
    }
    const entry = this.streams.get(zoneId);
    const sendspin = this.sendspinClients.get(zoneId);
    const active = sendspin?.getActiveStream() ?? null;
    if (!active) {
      return null;
    }
    const fmt = active.format;
    return {
      kind: 'pipe',
      path: `sendspin:${entry?.playerId ?? 'ma'}`,
      format: fmt.bitDepth && fmt.bitDepth > 16 ? 's32le' : 's16le',
      sampleRate: fmt.sampleRate || 48000,
      channels: fmt.channels || 2,
      stream: active.stream,
    };
  }

  /**
   * Request playback for a Music Assistant audiopath.
   * This registers the built-in player if needed, asks MA to play the media
   * on that player, waits for the PLAY_MEDIA event to provide the real stream
   * URL and returns it as a PlaybackSource.
   */
  public async startStreamForAudiopath(
    zoneId: number,
    zoneName: string,
    audiopath: string,
    options?: {
      flow?: boolean;
      parentAudiopath?: string;
      startItem?: string;
      startIndex?: number;
      metadata?: PlaybackMetadata;
      zoneConfig?: ZoneConfig;
    },
  ): Promise<MusicAssistantPlaybackResult> {
    const zoneConfig = options?.zoneConfig ?? this.resolveZoneConfig(zoneId);
    if (zoneConfig?.inputs?.musicassistant?.enabled === false) {
      return { playbackSource: null };
    }
    const maConfig = zoneConfig?.inputs?.musicassistant;
    const api = this.getApi();
    if (!api) {
      this.reportPlaybackError(zoneId, 'music assistant unavailable');
      return { playbackSource: null };
    }

    // Offload: play directly on a user-selected MA player/device without streaming.
    if (maConfig?.offload) {
      const targetId = (maConfig.deviceId ?? '').trim();
      if (!targetId) {
        this.log.warn('music assistant offload enabled but deviceId missing', { zoneId });
        this.reportPlaybackError(zoneId, 'music assistant device id missing');
        return { playbackSource: null };
      }

      const mediaId = this.decodeMediaId(audiopath);
      if (!mediaId) {
        this.log.warn('music assistant media id not resolved for offload', { zoneId, audiopath });
        this.reportPlaybackError(zoneId, 'music assistant media id unresolved');
        return { playbackSource: null };
      }
      const parentMediaId = options?.parentAudiopath ? this.decodeMediaId(options.parentAudiopath) : null;
      const playTarget = parentMediaId || mediaId;
      const playOpts: Record<string, unknown> = { option: 'replace', radio_mode: false };
      if (parentMediaId && mediaId) {
        playOpts.start_item = options?.startItem ? this.decodeMediaId(options.startItem) ?? mediaId : mediaId;
      }
      if (typeof options?.startIndex === 'number' && options.startIndex >= 0) {
        playOpts.start_index = options.startIndex;
      }

      try {
        this.log.info('music assistant offload play', { zoneId, playerId: targetId, media: playTarget });
        await api.connect();
        const ok = await api.playMedia(targetId, playTarget, playOpts);
        if (!ok) {
          this.log.warn('music assistant play_media failed', { zoneId, playerId: targetId });
          this.reportPlaybackError(zoneId, 'music assistant play failed');
          return { playbackSource: null };
        }
        this.zonePlayers.set(zoneId, targetId);
        this.playerToZone.set(targetId, zoneId);
        this.ensureSubscription(zoneId, targetId);
        if (options?.metadata) {
          this.lastMetadata.set(zoneId, options.metadata);
          this.lastMetadataKeys.set(zoneId, Object.keys(options.metadata));
        }
        void this.enrichMetadataFromApi(zoneId, mediaId);
        this.playingState.set(zoneId, true);
        return { playbackSource: null, outputOnly: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn('music assistant offload play failed', { zoneId, message });
        this.reportPlaybackError(zoneId, 'music assistant unavailable');
        return { playbackSource: null };
      }
    }

    const entry =
      (this.streams.get(zoneId) as StreamEntry | undefined) ??
      (await this.registerZone(zoneId, zoneName, zoneConfig));
    if (!entry) {
      this.reportPlaybackError(zoneId, 'music assistant unavailable');
      return { playbackSource: null };
    }
    this.zonePlayers.set(zoneId, entry.playerId);

    if (options?.metadata) {
      this.lastMetadata.set(zoneId, options.metadata);
      this.lastMetadataKeys.set(zoneId, Object.keys(options.metadata));
    }

    // Mark intent to play so we don't treat early stream/end from previous track as a real stop
    this.playingState.set(zoneId, true);
    this.lastPlayIntentAt.set(zoneId, Date.now());

    const mediaId = this.decodeMediaId(audiopath);
    if (!mediaId) {
      this.log.warn('music assistant media id not resolved', { zoneId, audiopath });
      this.reportPlaybackError(zoneId, 'music assistant media id unresolved');
      return { playbackSource: null };
    }
    const parentMediaId = options?.parentAudiopath ? this.decodeMediaId(options.parentAudiopath) : null;
    const playTarget = parentMediaId || mediaId;
    const playOpts: Record<string, unknown> = { option: 'replace', radio_mode: false };
    if (parentMediaId && mediaId) {
      playOpts.start_item = options?.startItem ? this.decodeMediaId(options.startItem) ?? mediaId : mediaId;
    }
    if (typeof options?.startIndex === 'number' && options.startIndex >= 0) {
      playOpts.start_index = options.startIndex;
    }
    // Kick off metadata enrichment immediately using the decoded media id.
    void this.enrichMetadataFromApi(zoneId, mediaId);

    const sendspin = this.sendspinClients.get(zoneId);
    const activeSendspin = sendspin?.getActiveStream() ?? null;
    const requestToken = this.markPendingStreamRequest(zoneId);
    const playMedia = async () => {
      try {
        this.log.info('music assistant play_media', {
          zoneId,
          playerId: entry.playerId,
          audiopath: mediaId,
          parent: parentMediaId || null,
          startIndex: options?.startIndex ?? null,
        });
        await api.connect();
        await api.playMedia(entry.playerId, playTarget, playOpts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn('music assistant play_media failed', { zoneId, message });
        this.reportPlaybackError(zoneId, 'music assistant unavailable');
      }
    };

    if (activeSendspin) {
      void playMedia().finally(() => this.clearPendingStreamRequest(zoneId, requestToken));
      const fmt = activeSendspin.format;
      this.playingState.set(zoneId, true);
      this.startKeepAlive(zoneId, entry.playerId);
      return {
        playbackSource: {
          kind: 'pipe',
          path: `sendspin:${entry.playerId}`,
          format: fmt.bitDepth && fmt.bitDepth > 16 ? 's32le' : 's16le',
          sampleRate: fmt.sampleRate || 48000,
          channels: fmt.channels || 2,
          stream: activeSendspin.stream,
        },
      };
    }

    try {
      if (sendspin && !sendspin.isReady()) {
        try {
          await sendspin.connect();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.warn('sendspin reconnect before play_media failed', { zoneId, message });
        }
      }
      await playMedia();
      const sendspinStream = sendspin ? await this.waitForSendspinStream(zoneId, sendspin) : null;
      if (sendspinStream) {
        const fmt = sendspinStream.format;
        this.playingState.set(zoneId, true);
        this.log.info('sendspin stream attached', {
          zoneId,
          playerId: entry.playerId,
          codec: fmt.codec,
          sampleRate: fmt.sampleRate,
          channels: fmt.channels,
          bitDepth: fmt.bitDepth,
        });
        return {
          playbackSource: {
            kind: 'pipe',
            path: `sendspin:${entry.playerId}`,
            format: fmt.bitDepth && fmt.bitDepth > 16 ? 's32le' : 's16le',
            sampleRate: fmt.sampleRate || 48000,
            channels: fmt.channels || 2,
            stream: sendspinStream.stream,
          },
        };
      }

      this.log.warn('music assistant sendspin stream not resolved', {
        zoneId,
        playerId: entry.playerId,
        audiopath: mediaId,
        parent: parentMediaId || null,
        startIndex: options?.startIndex ?? null,
      });
      this.reportPlaybackError(zoneId, 'music assistant stream unavailable');
      return { playbackSource: null };
    } finally {
      this.clearPendingStreamRequest(zoneId, requestToken);
    }
  }

  private getApi(): MusicAssistantApi | null {
    if (!this.host) {
      return null;
    }
    if (!this.api) {
      this.api = MusicAssistantApi.acquire(this.host, this.port, this.apiKey);
    }
    return this.api;
  }

  private reportPlaybackError(zoneId: number, reason: string): void {
    const trimmed = reason.trim();
    if (!trimmed) {
      return;
    }
    this.outputHandlers.onOutputError(zoneId, trimmed);
  }

  private removeSubscription(zoneId: number): void {
    const unsub = this.subs.get(zoneId);
    if (unsub) {
      unsub();
      this.subs.delete(zoneId);
    }
    this.zonePlayers.delete(zoneId);
  }

  private ensureSubscription(zoneId: number, playerId: string): void {
    if (!this.api || this.subs.has(zoneId)) {
      return;
    }
    const unsubBuiltin = this.api.subscribe(
      'BUILTIN_PLAYER',
      (evt) => this.handleBuiltinEvent(zoneId, playerId, evt),
      playerId,
    );
    const unsubPlayer = this.api.subscribe(
      'PLAYER_UPDATED',
      (evt) => this.handlePlayerEvent(zoneId, playerId, evt),
      playerId,
    );
    const unsubQueue = this.api.subscribe(
      'QUEUE_UPDATED',
      (evt) => {
        void this.handleQueueEvent(zoneId, playerId, evt);
      },
      '*',
    );
    const unsubQueueAdded = this.api.subscribe(
      'QUEUE_ADDED',
      (evt) => {
        void this.handleQueueEvent(zoneId, playerId, evt);
      },
      '*',
    );
    const unsub = () => {
      unsubBuiltin();
      unsubPlayer();
      unsubQueue();
      unsubQueueAdded();
    };
    this.subs.set(zoneId, unsub);
  }

  private handleBuiltinEvent(zoneId: number, playerId: string, evt: Record<string, any>): void {
    const type = String(evt?.data?.type ?? '').toUpperCase();
    if (type === 'PLAY_MEDIA' || type === 'PLAY') {
      this.zonePlayers.set(zoneId, playerId);
      const metadata = this.extractMetadata(evt?.data);
      if (metadata) {
        this.lastMetadata.set(zoneId, metadata);
        this.lastMetadataKeys.set(zoneId, Object.keys(evt?.data || {}));
        this.log.info('music assistant metadata received', {
          zoneId,
          playerId,
          title: metadata.title || null,
          artist: metadata.artist || null,
          album: metadata.album || null,
          cover: metadata.coverurl || null,
          audiopath: metadata.audiopath || null,
          keys: Object.keys(evt?.data || {}),
        });
      } else {
        this.lastMetadataKeys.set(zoneId, Object.keys(evt?.data || {}));
        this.log.debug('music assistant metadata missing/empty', {
          zoneId,
          playerId,
          keys: Object.keys(evt?.data || {}),
        });
      }
      if (metadata && this.inputHandlers?.updateMetadata) {
        this.inputHandlers.updateMetadata(zoneId, metadata);
      }
      const mediaId = (evt?.data as any)?.media_id || (evt?.data as any)?.uri || (evt?.data as any)?.url;
      if (mediaId) {
        void this.enrichMetadataFromApi(zoneId, mediaId);
      }
      this.playingState.set(zoneId, true);
      this.streams.set(zoneId, { playerId });
      this.startKeepAlive(zoneId, playerId);
      this.log.info('music assistant stream updated', { zoneId, playerId });
      return;
    }
    if (type === 'PAUSE') {
      this.playingState.set(zoneId, false);
      return;
    }
    if (type === 'STOP') {
      if (this.recentPlayIntent(zoneId, 5000)) {
        this.log.debug('music assistant STOP ignored; recent play intent', { zoneId, playerId });
        return;
      }
      this.playingState.set(zoneId, false);
      this.stopKeepAlive(zoneId);
      this.removeSubscription(zoneId);
      return;
    }
  }

  public async playerCommand(
    zoneId: number,
    command: string,
    args?: Record<string, unknown>,
  ): Promise<boolean> {
    const api = this.getApi();
    if (!api) {
      return false;
    }
    const playerId =
      this.zonePlayers.get(zoneId) ??
      this.streams.get(zoneId)?.playerId ??
      Array.from(this.playerToZone.entries()).find(([, zid]) => zid === zoneId)?.[0] ??
      '';
    if (!playerId) {
      return false;
    }
    if (command.toLowerCase() === 'pause') {
      this.markPaused(zoneId);
    }
    return api.playerCommand(playerId, command, args);
  }

  private handlePlayerEvent(zoneId: number, playerId: string, evt: Record<string, any>): void {
    const data = evt?.data ?? {};
    const current = data.current_media ?? data.media ?? data.item ?? null;
    const available = typeof data.available === 'boolean' ? data.available : undefined;
    if (available === false) {
      this.log.info('music assistant player unavailable; attempting re-register', { zoneId, playerId });
      void this.registerZone(zoneId, this.resolveZoneName(zoneId), this.resolveZoneConfig(zoneId));
    }
    if (typeof data.state === 'string') {
      const normalized = data.state.toLowerCase();
      if (normalized === 'playing') {
        this.playingState.set(zoneId, true);
      } else if (normalized === 'paused' || normalized === 'idle' || normalized === 'off') {
        this.playingState.set(zoneId, false);
      }
    }
    if (!current) {
      return;
    }
    const payload = {
      media: current,
      duration: current.duration ?? data.duration,
      type: current.media_type ?? data.media_type,
    };
    const metadata = this.extractMetadata(payload);
    if (!metadata) {
      return;
    }
    this.lastMetadata.set(zoneId, metadata);
    this.lastMetadataKeys.set(zoneId, Object.keys(data || {}));
    this.log.debug('music assistant player metadata received', {
      zoneId,
      playerId,
      title: metadata.title || null,
      artist: metadata.artist || null,
      album: metadata.album || null,
      cover: metadata.coverurl || null,
      audiopath: metadata.audiopath || null,
      keys: Object.keys(data || {}),
    });
    if (this.inputHandlers?.updateMetadata) {
      this.inputHandlers.updateMetadata(zoneId, metadata);
    }
    if (this.inputHandlers?.updateTiming) {
      const elapsedRaw = current.elapsed_time ?? data.elapsed_time ?? data.seconds_played;
      const durationRaw = current.duration ?? data.duration;
      const elapsed = typeof elapsedRaw === 'number' && elapsedRaw >= 0 ? elapsedRaw : 0;
      const duration = typeof durationRaw === 'number' && durationRaw > 0 ? durationRaw : 0;
      if (elapsed > 0 || duration > 0) {
        this.inputHandlers.updateTiming(zoneId, elapsed, duration);
      }
    }
  }

  private async handleQueueEvent(zoneId: number, playerId: string, evt: Record<string, any>): Promise<void> {
    if (!this.playingState.get(zoneId)) {
      return;
    }
    const data = evt?.data ?? {};
    const playerLower = String(playerId ?? '').toLowerCase();
    const queueIdRaw = String(evt?.object_id ?? data.queue_id ?? data.queue ?? '').trim();
    const queueLower = queueIdRaw.toLowerCase();
    const playerMatch = String(data.player_id ?? '').toLowerCase() === playerLower;
    if (queueLower && queueLower !== playerLower && !playerMatch) {
      return;
    }
    const queueId = queueIdRaw || playerId;
    if (!queueId) {
      return;
    }
    const lastFetchAt = this.queueFetches.get(zoneId) ?? 0;
    const now = Date.now();
    if (now - lastFetchAt < 1000) {
      return;
    }
    this.queueFetches.set(zoneId, now);
    const api = this.getApi();
    if (!api) {
      return;
    }

    const pageSize = 200;
    const totalHint = typeof data.items === 'number' ? data.items : Number.POSITIVE_INFINITY;
    const items: any[] = [];
    let offset = 0;
    while (offset < totalHint && items.length < 1000) {
      const page = await api.getQueueItems(queueId, offset, pageSize);
      if (!page.length) {
        break;
      }
      items.push(...page);
      offset += page.length;
      if (page.length < pageSize) {
        break;
      }
    }
    if (!items.length) {
      return;
    }

    const mapped = items
      .map((item, idx) => this.mapQueueItem(item, idx))
      .filter(Boolean) as QueueItem[];
    if (!mapped.length) {
      return;
    }

    const currentIndex = typeof data.current_index === 'number' ? data.current_index : 0;
    this.outputHandlers.onQueueUpdate(zoneId, mapped, currentIndex);
  }

  private mapQueueItem(item: any, idx: number): QueueItem | null {
    if (!item) {
      return null;
    }
    const media = item.media_item ?? item.media ?? item.item ?? null;
    const title = media?.name || item.name || '';
    const artist =
      media?.artist ||
      (Array.isArray(media?.artists) ? media.artists.map((a: any) => a?.name || '').filter(Boolean).join(', ') : '') ||
      '';
    const album = media?.album?.name || media?.album || '';
    const cover = this.extractCover(media ?? item);
    const duration =
      typeof item.duration === 'number' && item.duration > 0
        ? Math.round(item.duration)
        : typeof media?.duration === 'number' && media.duration > 0
          ? Math.round(media.duration)
          : undefined;
    const rawUri =
      media?.uri ||
      media?.url ||
      item?.uri ||
      item?.streamdetails?.stream_metadata?.uri ||
      undefined;
    const typeHint =
      media?.media_type ||
      item?.media_type ||
      item?.streamdetails?.media_type ||
      'track';
    const audiopath = this.toLoxoneAudiopath(rawUri, typeHint) || '';
    if (!title && !audiopath) {
      return null;
    }
    return {
      album: album || '',
      artist: artist || '',
      audiopath,
      audiotype: 5,
      coverurl: cover || '',
      duration: typeof duration === 'number' ? duration : 0,
      qindex: idx,
      station: '',
      title: title || '',
      unique_id: item.queue_item_id || item.item_id || generateQueueId(),
      user: this.providerId || 'musicassistant',
    };
  }

  private extractMetadata(data: any): PlaybackMetadata | null {
    if (!data) {
      return null;
    }
    const meta: PlaybackMetadata = {
      title: '',
      artist: '',
      album: '',
    };
    const src = data.metadata || data.media || data.item || data;
    meta.title =
      src?.title ||
      src?.name ||
      src?.media_title ||
      src?.track_name ||
      '';
    meta.artist =
      src?.artist ||
      src?.artists?.[0]?.name ||
      src?.album_artist ||
      '';
    meta.album = src?.album?.name || src?.album || '';
    const cover = this.extractCover(src);
    const duration =
      typeof src?.duration === 'number' && src.duration > 0
        ? Math.round(src.duration)
        : typeof data?.duration === 'number' && data.duration > 0
          ? Math.round(data.duration)
          : undefined;
    if (cover) {
      meta.coverurl = cover;
    }
    const rawAudiopath =
      typeof src?.media_id === 'string'
        ? src.media_id
        : typeof src?.uri === 'string'
          ? src.uri
          : undefined;
    const audiopath = this.toLoxoneAudiopath(
      rawAudiopath,
      src?.type || data?.type || data?.media_type || 'track',
    );
    if (audiopath) {
      meta.audiopath = audiopath;
    }
    if (duration) {
      meta.duration = duration;
    }
    if (!meta.title && !meta.artist && !meta.album && !meta.coverurl && !meta.audiopath && !meta.duration) {
      return null;
    }
    return meta;
  }

  private extractCover(obj: any): string {
    const images = obj?.metadata?.images || obj?.images || obj?.covers || obj?.artwork;
    if (Array.isArray(images) && images.length) {
      const img = images.find((i: any) => i?.path || i?.url || i?.link) || images[0];
      const path = img?.path || img?.url || img?.link;
      if (typeof path === 'string') {
        return this.resizeCover(path);
      }
    }
    if (typeof obj?.image === 'string') {
      return this.resizeCover(obj.image);
    }
    if (typeof obj?.image_url === 'string') {
      return this.resizeCover(obj.image_url);
    }
    if (typeof obj?.cover === 'string') {
      return this.resizeCover(obj.cover);
    }
    if (typeof obj?.thumbnail === 'string') {
      return this.resizeCover(obj.thumbnail);
    }
    return '';
  }

  private resizeCover(url: string): string {
    if (!url) {
      return '';
    }
    try {
      const parsed = new URL(url);
      if (parsed.pathname.includes('imageproxy') && !parsed.searchParams.has('size')) {
        parsed.searchParams.set('size', '256');
        return parsed.toString();
      }
      if (parsed.hostname.includes('mzstatic.com')) {
        parsed.pathname = parsed.pathname.replace(/\/(\d{2,5})x\1bb\.jpg/i, '/256x256bb.jpg');
        return parsed.toString();
      }
    } catch {
      /* ignore */
    }
    return url;
  }

  private decodeBase64Deep(value: string): string {
    let current = value;
    for (let i = 0; i < 4; i += 1) {
      const idx = current.indexOf('b64_');
      if (idx < 0) {
        break;
      }
      const encoded = current.slice(idx + 4);
      try {
        const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
        current = current.slice(0, idx) + decoded;
      } catch {
        break;
      }
    }
    return current;
  }

  private decodeMediaId(audiopath: string): string {
    const cleaned = decodeAudiopath(audiopath);
    const deepDecoded = this.decodeBase64Deep(cleaned);
    if (deepDecoded !== cleaned) {
      return deepDecoded;
    }
    const parts = cleaned.split(':');
    const last = parts[parts.length - 1] || '';
    if (last.startsWith('b64_')) {
      try {
        return Buffer.from(last.slice(4), 'base64').toString('utf-8');
      } catch {
        return cleaned;
      }
    }
    return cleaned;
  }

  private startKeepAlive(zoneId: number, playerId: string): void {
    const existing = this.keepAliveTimers.get(zoneId);
    if (existing) {
      clearInterval(existing);
    }
    // Sendspin: keep the WebSocket alive by reconnecting when needed.
    if (this.apiKey) {
      const client = this.sendspinClients.get(zoneId);
      if (!client) {
        return;
      }
      const tick = async () => {
        try {
          await client.connect();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.debug('sendspin keepalive failed', { zoneId, message });
        }
      };
      const timer = setInterval(tick, 10000);
      this.keepAliveTimers.set(zoneId, timer);
      void tick();
      return;
    }
    if (!this.api) {
      return;
    }
    const tick = async () => {
      if (!this.api) {
        return;
      }
      const playing = this.playingState.get(zoneId) ?? true;
      try {
        await this.api.updateBuiltinPlayerState(playerId, { powered: true, playing, paused: !playing });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.debug('music assistant keepalive failed', { zoneId, message });
      }
    };
    const timer = setInterval(tick, 10000);
    this.keepAliveTimers.set(zoneId, timer);
  }

  private stopKeepAlive(zoneId: number): void {
    const timer = this.keepAliveTimers.get(zoneId);
    if (timer) {
      clearInterval(timer);
    }
    this.keepAliveTimers.delete(zoneId);
  }

  private markPendingStreamRequest(zoneId: number): number {
    const token = this.streamRequestSeq + 1;
    this.streamRequestSeq = token;
    this.pendingStreamRequests.set(zoneId, token);
    return token;
  }

  private clearPendingStreamRequest(zoneId: number, token: number): void {
    if (this.pendingStreamRequests.get(zoneId) === token) {
      this.pendingStreamRequests.delete(zoneId);
    }
  }

  private markPaused(zoneId: number): void {
    this.lastPauseAt.set(zoneId, Date.now());
  }

  private recentlyPaused(zoneId: number, ms = 5000): boolean {
    const ts = this.lastPauseAt.get(zoneId);
    return typeof ts === 'number' && Date.now() - ts < ms;
  }

  private toLoxoneAudiopath(mediaId: string | undefined, typeHint = 'track'): string | undefined {
    if (!mediaId) {
      return undefined;
    }
    const ref = this.parseMaMediaRef(mediaId);
    const type = ref.type || typeHint || 'track';
    const raw = ref.id && ref.provider ? `${ref.provider}://${type}/${ref.id}` : mediaId;
    return encodeAudiopath(raw, type, this.providerId);
  }

  private handleInputStreamStart(zoneId: number, playerId: string, stream: PassThrough, fmt: StreamFormat): void {
    if (!this.inputHandlers?.startPlayback) {
      return;
    }
    this.lastStreamStartAt.set(zoneId, Date.now());
    const meta = this.lastMetadata.get(zoneId);
    const source: PlaybackSource = {
      kind: 'pipe',
      path: `sendspin:${playerId}`,
      format: fmt.bitDepth && fmt.bitDepth > 16 ? 's32le' : 's16le',
      sampleRate: fmt.sampleRate || 48000,
      channels: fmt.channels || 2,
      stream,
    };
    const encodedAudiopath = this.toLoxoneAudiopath(meta?.audiopath ?? `musicassistant://${playerId}`);
    const metadata: PlaybackMetadata = {
      title: meta?.title ?? '',
      artist: meta?.artist ?? '',
      album: meta?.album ?? '',
      coverurl: meta?.coverurl ?? undefined,
      audiopath: encodedAudiopath,
      duration: meta?.duration,
      station: meta?.station,
      trackId: meta?.trackId,
    };
    if (!meta) {
      this.log.info('music assistant metadata missing; using fallback', {
        zoneId,
        playerId,
        keys: this.lastMetadataKeys.get(zoneId) ?? [],
      });
    }
    this.log.info('music assistant input stream start', {
      zoneId,
      playerId,
      sampleRate: source.sampleRate,
      channels: source.channels,
      title: metadata.title,
      artist: metadata.artist,
    });
    if (this.pendingStreamRequests.has(zoneId)) {
      this.log.debug('music assistant stream start suppressed; request in progress', {
        zoneId,
        playerId,
      });
      if (this.inputHandlers?.updateMetadata) {
        this.inputHandlers.updateMetadata(zoneId, metadata);
      }
      return;
    }
    this.inputHandlers.startPlayback(zoneId, 'musicassistant', source, metadata);
  }

  private handleInputStreamStop(zoneId: number, playerId: string): void {
    if (!this.inputHandlers?.stopPlayback) {
      return;
    }
    if (this.playingState.get(zoneId) === true) {
      this.log.debug('music assistant stream stop ignored; MA still playing', {
        zoneId,
        playerId,
      });
      return;
    }
    if (this.recentPlayIntent(zoneId, 6000)) {
      this.log.debug('music assistant stream stop ignored; recent play intent', {
        zoneId,
        playerId,
      });
      return;
    }
    this.log.info('music assistant input stream stop', { zoneId, playerId });
    this.inputHandlers?.stopPlayback?.(zoneId);
  }

  private handleInputMetadata(zoneId: number, playerId: string, metadata: PlaybackMetadata): void {
    if (!metadata) {
      return;
    }
    const encodedAudiopath = this.toLoxoneAudiopath(metadata.audiopath);
    const normalized: PlaybackMetadata = encodedAudiopath
      ? { ...metadata, audiopath: encodedAudiopath }
      : metadata;
    this.lastMetadata.set(zoneId, normalized);
    this.log.info('music assistant metadata (sendspin)', {
      zoneId,
      playerId,
      title: normalized.title || null,
      artist: normalized.artist || null,
      album: normalized.album || null,
      cover: normalized.coverurl || null,
      audiopath: normalized.audiopath || null,
    });
    if (this.inputHandlers?.updateMetadata) {
      this.inputHandlers.updateMetadata(zoneId, normalized);
    }
  }

  private handleInputCommand(
    zoneId: number,
    playerId: string,
    payload: { command?: string; volume?: number; mute?: boolean },
  ): void {
    const volume =
      typeof payload.volume === 'number' && Number.isFinite(payload.volume)
        ? Math.max(0, Math.min(100, Math.round(payload.volume)))
        : null;
    const muted = typeof payload.mute === 'boolean' ? payload.mute : null;
    const cmd = (payload.command || '').toString().toLowerCase();
    const deltaStep = 5;
    let effectiveVolume = volume;

    if (effectiveVolume === null && cmd) {
      const current = this.lastVolume.get(zoneId) ?? 100;
      if (cmd === 'volume_up' || cmd === 'vol_up' || cmd === 'volumeup') {
        effectiveVolume = Math.min(100, current + deltaStep);
      } else if (cmd === 'volume_down' || cmd === 'vol_down' || cmd === 'volumedown' || cmd === 'volume_decrease') {
        effectiveVolume = Math.max(0, current - deltaStep);
      }
    }
    if (volume !== null) {
      this.lastVolume.set(zoneId, volume);
      this.inputHandlers?.updateVolume?.(zoneId, volume);
    } else if (effectiveVolume !== null) {
      this.lastVolume.set(zoneId, effectiveVolume);
      this.inputHandlers?.updateVolume?.(zoneId, effectiveVolume);
    } else if (muted === true && this.lastVolume.has(zoneId)) {
      // Fallback: treat mute as volume 0 when explicit level is missing.
      this.inputHandlers?.updateVolume?.(zoneId, 0);
    }
    if (cmd === 'pause' || cmd === 'stop') {
      this.playingState.set(zoneId, false);
      if (cmd === 'pause') {
        this.markPaused(zoneId);
      }
    }
    if (cmd === 'play' || cmd === 'resume') {
      this.playingState.set(zoneId, true);
    }
    this.log.debug('music assistant command (sendspin)', {
      zoneId,
      playerId,
      command: cmd || null,
      volume: volume !== null ? volume : null,
      mute: muted,
    });
  }

  private parseMaMediaRef(mediaId: string): { type: string | null; id: string | null; provider: string | null } {
    if (!mediaId) {
      return { type: null, id: null, provider: null };
    }
    if (mediaId.includes('://')) {
      const [scheme, restRaw] = mediaId.split('://');
      const rest = restRaw || '';
      const [maybeType, ...restParts] = rest.split('/');
      const type = maybeType || null;
      const id = restParts.join('/') || null;
      return { type, id, provider: scheme || null };
    }
    const parts = mediaId.split(':');
    if (parts.length >= 3) {
      const provider = parts[0] || null;
      const type = parts[1] || null;
      const id = parts.slice(2).join(':') || null;
      return { type, id, provider };
    }
    return { type: null, id: mediaId || null, provider: null };
  }

  private toMetadataFromTrack(track: any): PlaybackMetadata | null {
    if (!track) {
      return null;
    }
    const title =
      track?.title ||
      track?.name ||
      track?.media_title ||
      track?.track_name ||
      '';
    const artist =
      track?.artist ||
      track?.artists?.[0]?.name ||
      track?.album_artist ||
      '';
    const album = track?.album?.name || track?.album || '';
    const cover = this.extractCover(track);
    const duration =
      typeof track?.duration === 'number' && track.duration > 0
        ? Math.round(track.duration)
        : undefined;
    const rawAudiopath =
      typeof track?.media_id === 'string'
        ? track.media_id
        : typeof track?.uri === 'string'
          ? track.uri
          : undefined;
    const audiopath = this.toLoxoneAudiopath(rawAudiopath, track?.type || 'track');
    if (!title && !artist && !album && !cover && !audiopath && !duration) {
      return null;
    }
    const meta: PlaybackMetadata = {
      title: title || '',
      artist: artist || '',
      album: album || '',
    };
    if (cover) {
      meta.coverurl = cover;
    }
    if (audiopath) {
      meta.audiopath = audiopath;
    }
    if (duration) {
      meta.duration = duration;
    }
    return meta;
  }

  private async enrichMetadataFromApi(zoneId: number, mediaId: string): Promise<void> {
    const api = this.getApi();
    if (!api) {
      return;
    }
    const decoded = this.decodeMediaId(mediaId);
    const ref = this.parseMaMediaRef(decoded);
    if (ref.type !== 'track' || !ref.id) {
      return;
    }
    try {
      const track = await api.getTrack(ref.id, ref.provider || 'library');
      const meta = this.toMetadataFromTrack(track);
      if (meta) {
        this.lastMetadata.set(zoneId, meta);
        this.lastMetadataKeys.set(zoneId, Object.keys(track || {}));
        this.log.info('music assistant metadata (api)', {
          zoneId,
          mediaId: decoded,
          title: meta.title || null,
          artist: meta.artist || null,
          album: meta.album || null,
          cover: meta.coverurl || null,
          provider: ref.provider || 'library',
        });
        if (this.inputHandlers?.updateMetadata) {
          this.inputHandlers.updateMetadata(zoneId, meta);
        }
      } else {
        this.log.debug('music assistant metadata (api) empty', { zoneId, mediaId: decoded, provider: ref.provider || 'library' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.debug('music assistant metadata lookup failed', { zoneId, mediaId: decoded, provider: ref.provider || 'library', message });
    }
  }

  private async waitForSendspinStream(
    zoneId: number,
    client: SendspinClient,
    baseTimeoutMs = 8000,
  ): Promise<{ stream: PassThrough; format: StreamFormat } | null> {
    const maxWaitMs = this.playingState.get(zoneId) === true ? Math.max(15000, baseTimeoutMs) : baseTimeoutMs;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const remaining = Math.max(1000, deadline - Date.now());
      const chunk = await client.awaitStream(Math.min(5000, remaining));
      if (chunk) {
        return chunk;
      }
      if (this.playingState.get(zoneId) !== true) {
        break;
      }
    }
    this.log.warn('sendspin stream await exceeded max wait', { zoneId, maxWaitMs, playing: this.playingState.get(zoneId) });
    return null;
  }

  private recentPlayIntent(zoneId: number, ms: number): boolean {
    const ts = this.lastPlayIntentAt.get(zoneId);
    return typeof ts === 'number' && Date.now() - ts < ms;
  }
}
