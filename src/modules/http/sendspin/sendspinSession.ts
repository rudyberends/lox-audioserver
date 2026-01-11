/**
 * Handles Sendspin handshake, state, and role messaging for a single client connection.
 */
import type { IncomingMessage } from 'node:http';
import util from 'node:util';
import type { RawData } from 'ws';
import { WebSocket } from 'ws';
import { createLogger } from '@/core/logging/logger';
import { serverNowUs } from '@/modules/http/sendspin/sendspinClock';
import { audioOutputSettings } from '@/modules/audio/utils/audioFormat';

export interface SendspinPcmFrame {
  data: Buffer;
  timestampUs?: number;
}

export interface PlayerFormat {
  codec: 'pcm' | 'opus' | 'flac';
  sampleRate: number;
  channels: number;
  bitDepth: number;
}

export interface SendspinPlayerStateUpdate {
  clientId: string | null;
  roles: string[];
  state?: string;
  volume?: number;
  muted?: boolean;
}

export interface SendspinGroupCommand {
  clientId: string | null;
  roles: string[];
  command: string;
  volume?: number;
  mute?: boolean;
}

export interface SendspinSessionHooks {
  onPlayerState?: (session: SendspinSession, update: SendspinPlayerStateUpdate) => void;
  onGroupCommand?: (session: SendspinSession, command: SendspinGroupCommand) => void;
  onIdentified?: (session: SendspinSession, req: IncomingMessage | null) => void;
  onDisconnected?: (session: SendspinSession) => void;
  onFormatChanged?: (
    session: SendspinSession,
    format: PlayerFormat,
  ) => void;
}

const log = createLogger('Sendspin', 'Session');

const serializeForLog = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return util.inspect(value, { depth: 4, breakLength: 120 });
  }
};

/** Represents a single client connection and implements core/role messaging. */
export type SendspinConnectionMeta = {
  zoneId?: number;
  playerId?: string;
  tunnel?: string | null;
  remote?: string | null;
};

export class SendspinSession {
  private ready = false;
  private clientId: string | null = null;
  private roles: string[] = [];
  private playerSupport: any = null;
  private artworkSupport: any[] = [];
  private artworkChannels: Array<{
    source: 'album' | 'artist' | 'none';
    format: 'jpeg' | 'png' | 'bmp';
    width: number;
    height: number;
  }> = [];
  private expectVolume = false;
  private expectMute = false;
  private warnedMissingVolume = false;
  private warnedMissingMute = false;
  private connectionReason: 'discovery' | 'playback' | 'cast-tunnel';
  private readonly connectionMeta: SendspinConnectionMeta;
  private initialStateReceived = false;
  private initialStateTimer: NodeJS.Timeout | null = null;

  private activeStream = false;
  private streamFormat: PlayerFormat = {
    codec: 'pcm',
    sampleRate: audioOutputSettings.sampleRate,
    channels: audioOutputSettings.channels,
    bitDepth: audioOutputSettings.pcmBitDepth,
  };

  private hooks: SendspinSessionHooks = {};
  private hooksAttached = false;
  private playbackState: 'playing' | 'paused' | 'stopped' = 'stopped';
  private lastStateSignature: string | null = null;
  private readonly maxBufferedSend = 1024 * 512; // ~512KB safety window for backpressure
  private backpressureDrops = 0;
  private lastBackpressureBytes = 0;
  private lastBackpressureTs = 0;
  private backpressureEvents: number[] = [];
  private lastTimeLogMs = 0;
  private lastTimeOffsetMs: number | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly req: IncomingMessage | null,
    connectionReason: 'discovery' | 'playback' | 'cast-tunnel' = 'discovery',
    connectionMeta: SendspinConnectionMeta = {},
    hooks: SendspinSessionHooks = {},
  ) {
    this.hooks = hooks;
    this.connectionReason = connectionReason;
    this.connectionMeta = { ...connectionMeta };
    this.applyConnectionContext({ ...connectionMeta });

    // If the client already sent hello before hooks were attached, fire onIdentified now.
    if (this.ready && this.hooks.onIdentified) {
      try {
        this.hooks.onIdentified(this, this.req);
      } catch (err) {
        log.warn('onIdentified hook failed', { message: (err as Error).message });
      }
    }
  }

  public setHooks(
    hooks: SendspinSessionHooks,
    context?: SendspinConnectionMeta & { reason?: 'cast-tunnel' },
  ): void {
    this.hooks = hooks;
    this.hooksAttached = true;
    if (context) {
      this.applyConnectionContext(context);
    }
    // If the client already sent hello, fire onIdentified immediately.
    if (this.ready && this.hooks.onIdentified) {
      try {
        this.hooks.onIdentified(this, this.req);
        log.debug('hooks applied after hello; onIdentified fired', { clientId: this.clientId });
      } catch (err) {
        log.warn('onIdentified hook failed', { message: (err as Error).message });
      }
    }
  }

  public getClientId(): string | null {
    return this.clientId;
  }

  public getRoles(): string[] {
    return this.roles;
  }

  public getInfo(): { id: string | null; roles: string[]; playbackState: string } {
    return {
      id: this.clientId,
      roles: this.roles,
      playbackState: this.playbackState,
    };
  }

  public getRemoteAddress(): string | null {
    return this.connectionMeta.remote ?? this.req?.socket?.remoteAddress ?? null;
  }

  public getBackpressureStats(): {
    drops: number;
    lastBytes: number;
    lastDropTs: number | null;
    recentDrops: number;
  } {
    const cutoff = Date.now() - 5 * 60 * 1000;
    this.backpressureEvents = this.backpressureEvents.filter((ts) => ts >= cutoff);
    return {
      drops: this.backpressureDrops,
      lastBytes: this.lastBackpressureBytes,
      lastDropTs: this.lastBackpressureTs || null,
      recentDrops: this.backpressureEvents.length,
    };
  }

  public getDescriptor(): {
    clientId: string | null;
    roles: string[];
    playbackState: 'playing' | 'paused' | 'stopped';
    remote: string | null;
  } {
    return {
      clientId: this.clientId,
      roles: [...this.roles],
      playbackState: this.playbackState,
      remote: this.getRemoteAddress(),
    };
  }

  public getConnectionReason(): 'discovery' | 'playback' | 'cast-tunnel' {
    return this.connectionReason;
  }

  public hasHooksAttached(): boolean {
    return this.hooksAttached;
  }

  public getArtworkChannels(): SendspinSession['artworkChannels'] {
    return [...this.artworkChannels];
  }

  public getPlayerBufferCapacity(): number {
    const cap = this.playerSupport?.buffer_capacity;
    return typeof cap === 'number' && cap > 0 ? cap : 0;
  }

  public handleText(json: string): void {
    let msg: any;
    try {
      msg = JSON.parse(json);
    } catch {
      return;
    }

    if (!this.ready) {
      if (msg.type !== 'client/hello') {
        log.warn('client message before hello; closing connection', {
          clientId: this.clientId ?? 'unknown',
          type: msg?.type ?? 'unknown',
        });
        try {
          this.ws.close(1008, 'expected client/hello first');
        } catch {
          /* ignore */
        }
        return;
      }
      this.handleHello(msg.payload);
      return;
    }

    switch (msg.type) {
      case 'client/hello':
        log.warn('duplicate client/hello ignored', { clientId: this.clientId ?? 'unknown' });
        break;
      case 'client/time':
        this.handleTime(msg.payload);
        break;
      case 'client/state':
        this.handleState(msg.payload);
        break;
      case 'client/command':
        this.handleCommand(msg.payload);
        break;
      case 'client/goodbye':
        this.handleGoodbye(msg.payload);
        break;
      case 'stream/request-format':
        this.handleFormatRequest(msg.payload);
        break;
      default:
        this.logClientMessage(msg?.type ?? 'unknown', {});
        break;
    }
  }

  public handleBinary(data: RawData): void {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    const logFields: Record<string, any> = {
      clientId: this.clientId ?? 'unknown',
      bytes: buffer.length,
      connection: this.connectionReason,
    };
    if (typeof this.connectionMeta.zoneId === 'number') {
      logFields.zone = this.connectionMeta.zoneId;
    }
    if (this.connectionMeta.playerId) {
      logFields.playerId = this.connectionMeta.playerId;
    }
    if (this.connectionMeta.remote) {
      logFields.remote = this.connectionMeta.remote;
    }
    log.info('recv binary', logFields);
  }

  public sendVisualizerStreamStart(config: Record<string, any> = {}): void {
    if (!this.ready) return;
    if (!this.roles.includes('visualizer@v1')) return;
    this.send({
      type: 'stream/start',
      payload: {
        visualizer: { ...config },
      },
    });
  }

  public sendVisualizerFrame(data: Buffer, timestampUs?: number): void {
    if (!this.ready) return;
    if (!this.roles.includes('visualizer@v1')) return;
    const ts = typeof timestampUs === 'number' ? timestampUs : serverNowUs();
    const header = Buffer.alloc(1 + 8);
    header.writeUInt8(16, 0); // Visualizer binary slot
    header.writeBigInt64BE(BigInt(ts), 1);
    const payload = Buffer.concat([header, data]);
    this.sendBinary(payload);
  }

  public sendPcmAudioFrame(frame: SendspinPcmFrame): void {
    if (!this.ready) return;
    if (this.ws.readyState !== WebSocket.OPEN) return;

    this.ensureStreamStarted();

    const payload = frame.data;
    if (!payload?.length) return;

    const timestampUs =
      typeof frame.timestampUs === 'number' ? frame.timestampUs : serverNowUs();

    const header = Buffer.alloc(1 + 8);
    // Binary message type 4 = AUDIO_CHUNK (Sendspin spec)
    header.writeUInt8(4, 0);
    header.writeBigInt64BE(BigInt(timestampUs), 1);

    const packet = Buffer.concat([header, payload]);
    const buffered = typeof this.ws.bufferedAmount === 'number' ? this.ws.bufferedAmount : 0;
    if (buffered > this.maxBufferedSend) {
      // Throttle: defer a bit instead of dropping when socket buffer is high.
      setTimeout(() => {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.sendBinary(packet);
        }
      }, 5);
      return;
    }
    this.sendBinary(packet);
  }

  public sendGroupCommand(command: string, extra?: { volume?: number; mute?: boolean }): void {
    if (!this.ready) return;
    this.send({
      type: 'group/command',
      payload: { command, ...(extra ?? {}) },
    });
  }

  public sendServerCommand(command: 'volume' | 'mute', extra?: { volume?: number; mute?: boolean }): void {
    if (!this.ready) return;
    this.send({
      type: 'server/command',
      payload: { player: { command, ...(extra ?? {}) } },
    });
  }

  public sendGroupUpdate(update: {
    playback_state?: 'playing' | 'paused' | 'stopped';
    group_id?: string;
    group_name?: string;
  }): void {
    if (!this.ready) return;
    if (update.playback_state) {
      this.playbackState = update.playback_state;
    }
    this.send({
      type: 'group/update',
      payload: update,
    });
  }

  public sendMetadata(metadata: {
    title?: string | null;
    artist?: string | null;
    album_artist?: string | null;
    album?: string | null;
    artwork_url?: string | null;
    year?: number | null;
    track?: number | null;
    repeat?: 'off' | 'one' | 'all' | null;
    shuffle?: boolean | null;
    progress?: {
      track_progress: number;
      track_duration: number;
      playback_speed: number;
    } | null;
  }): void {
    if (!this.ready) return;
    this.send({
      type: 'server/state',
      payload: {
        metadata: {
          timestamp: serverNowUs(),
          ...metadata,
        },
      },
    });
  }

  public sendControllerState(controller: {
    supported_commands: string[];
    volume: number;
    muted: boolean;
  }): void {
    if (!this.ready) return;
    this.send({
      type: 'server/state',
      payload: { controller },
    });
  }

  public sendArtwork(channel: 0 | 1 | 2 | 3, imageData: Buffer | null): void {
    if (!this.ready) return;
    const messageType = 8 + channel; // ARTWORK_CHANNEL_0 starts at 8
    const timestamp = serverNowUs();
    const header = Buffer.alloc(1 + 8);
    header.writeUInt8(messageType, 0);
    header.writeBigInt64BE(BigInt(timestamp), 1);
    const payload = imageData ?? Buffer.alloc(0);
    this.sendBinary(Buffer.concat([header, payload]));
  }

  public sendStreamClear(roles?: string[]): void {
    if (!this.ready) return;
    this.send({
      type: 'stream/clear',
      payload: roles && roles.length ? { roles } : {},
    });
  }

  public sendStreamEnd(roles?: string[]): void {
    if (!this.ready) return;
    this.activeStream = false;
    this.send({
      type: 'stream/end',
      payload: roles && roles.length ? { roles } : {},
    });
  }

  public sendStreamStart(format?: {
    codec?: PlayerFormat['codec'];
    sampleRate?: number;
    channels?: number;
    bitDepth?: number;
    codecHeader?: string;
  }): void {
    if (!this.ready) return;
    const { codec, sampleRate, channels, bitDepth } = {
      codec: format?.codec ?? this.streamFormat.codec,
      sampleRate: format?.sampleRate ?? this.streamFormat.sampleRate,
      channels: format?.channels ?? this.streamFormat.channels,
      bitDepth: format?.bitDepth ?? this.streamFormat.bitDepth,
    };
    this.streamFormat = { codec, sampleRate, channels, bitDepth };
    this.send({
      type: 'stream/start',
      payload: {
        player: {
          codec,
          sample_rate: sampleRate,
          channels,
          bit_depth: bitDepth,
          ...(format?.codecHeader ? { codec_header: format.codecHeader } : {}),
        },
      },
    });
    this.activeStream = true;
  }

  public sendArtworkStreamStart(
    channels: Array<{ source: 'album' | 'artist' | 'none'; format: 'jpeg' | 'png' | 'bmp'; width: number; height: number }>,
  ): void {
    if (!this.ready) return;
    if (!this.roles.includes('artwork@v1')) return;
    this.artworkChannels = channels;
    this.send({
      type: 'stream/start',
      payload: {
        artwork: {
          channels,
        },
      },
    });
  }

  public destroy(): void {
    this.activeStream = false;
    if (this.initialStateTimer) {
      clearTimeout(this.initialStateTimer);
      this.initialStateTimer = null;
    }
    if (this.hooks.onDisconnected) {
      try {
        this.hooks.onDisconnected(this);
      } catch (err) {
        log.warn('onDisconnected hook failed', { message: (err as Error).message });
      }
    }
  }

  private ensureStreamStarted(): void {
    if (this.activeStream) return;
    if (this.ws.readyState !== WebSocket.OPEN) return;

    this.sendStreamStart(this.streamFormat);
  }

  private handleHello(payload: any): void {
    this.clientId = payload?.client_id || 'unknown';
    const supportedRoles = Array.isArray(payload?.supported_roles) ? payload.supported_roles : [];
    const serverSupported = new Set(['player@v1', 'controller@v1', 'metadata@v1', 'artwork@v1', 'visualizer@v1']);

    // Activate the first supported version per role family, respecting client priority.
    const activeRoles: string[] = [];
    const seenFamilies = new Set<string>();
    for (const role of supportedRoles) {
      if (typeof role !== 'string') continue;
      const family = role.split('@')[0];
      if (seenFamilies.has(family)) continue;
      if (serverSupported.has(role)) {
        activeRoles.push(role);
        seenFamilies.add(family);
      }
    }
    this.roles = activeRoles;

    this.playerSupport = payload?.['player@v1_support'] || payload?.player_support || {};
    const supportedCommands: string[] = Array.isArray(this.playerSupport?.supported_commands)
      ? this.playerSupport.supported_commands
      : [];
    this.expectVolume = supportedCommands.includes('volume');
    this.expectMute = supportedCommands.includes('mute');
    log.debug('client capabilities', {
      clientId: this.clientId,
      roles: this.roles.join(','),
      playerSupport: serializeForLog(this.playerSupport),
      expectVolume: this.expectVolume,
      expectMute: this.expectMute,
    });
    this.artworkSupport = Array.isArray(payload?.['artwork@v1_support']?.channels)
      ? payload['artwork@v1_support'].channels
      : [];
    if (this.artworkSupport.length) {
      this.artworkChannels = this.artworkSupport.map((c: any) => ({
        source: c?.source === 'artist' ? 'artist' : c?.source === 'none' ? 'none' : 'album',
        format: c?.format === 'png' ? 'png' : c?.format === 'bmp' ? 'bmp' : 'jpeg',
        width: typeof c?.media_width === 'number' ? c.media_width : 800,
        height: typeof c?.media_height === 'number' ? c.media_height : 800,
      }));
    }
    this.applyPreferredStreamFormat();
    this.ready = true;

    log.info('client/hello', {
      clientId: this.clientId,
      roles: this.roles.join(','),
    });

    // Reply with server/hello first as per the Sendspin protocol.
    this.send({
      type: 'server/hello',
      payload: {
        server_id: 'lox-audioserver',
        name: 'Lox Audio Server',
        version: 1,
        active_roles: this.roles.length
          ? Array.from(new Set(this.roles))
          : ['player@v1', 'controller@v1', 'metadata@v1'],
        connection_reason: this.connectionReason,
      },
    });

    this.startInitialStateTimeout();

    // After the handshake, notify the transport that the client is ready.
    if (this.hooks.onIdentified) {
      try {
        this.hooks.onIdentified(this, this.req);
      } catch (err) {
        log.warn('onIdentified hook failed', { message: (err as Error).message });
      }
    } else {
      log.debug('client/hello received; waiting for hooks to attach', { clientId: this.clientId });
    }

  }

  private handleTime(payload: any): void {
    const clientTransmitted =
      typeof payload?.client_transmitted === 'number' ? payload.client_transmitted : null;
    const serverReceived = serverNowUs();
    // Capture transmit time separately to avoid reporting a zero server processing interval.
    let serverTransmitted = serverReceived;
    // Per spec: just echo the timestamps we know. Offset/drift is computed client-side.
    // Note: the server does not know t4 (client receive time), so we only log what we have.
    const offsetUs =
      clientTransmitted !== null ? serverReceived - clientTransmitted : undefined;
    const offsetMs = typeof offsetUs === 'number' ? Math.round(offsetUs / 1000) : undefined;
    const nowMs = Date.now();
    const shouldLog =
      offsetMs === undefined ||
      this.lastTimeOffsetMs === null ||
      Math.abs(offsetMs - this.lastTimeOffsetMs) > 5 ||
      nowMs - this.lastTimeLogMs > 5000;
    if (shouldLog) {
      this.lastTimeOffsetMs = offsetMs ?? this.lastTimeOffsetMs;
      this.lastTimeLogMs = nowMs;
      this.logClientMessage(
        'client/time',
        {
          t1: clientTransmitted ?? undefined,
          t2: serverReceived,
          t3: serverTransmitted,
          offsetMs,
        },
        'spam',
      );
    }

    // Refresh transmit timestamp immediately before sending to better reflect on-wire timing.
    serverTransmitted = serverNowUs();
    this.sendTimeResponse(clientTransmitted, serverReceived, serverTransmitted);
  }

  private sendTimeResponse(clientTransmitted: number | null, serverReceived: number, serverTransmitted: number): void {
    this.send({
      type: 'server/time',
      payload: {
        client_transmitted: clientTransmitted,
        server_received: serverReceived,
        server_transmitted: serverTransmitted,
      },
    });
  }

  private handleState(payload: any): void {
    if (!this.initialStateReceived) {
      this.initialStateReceived = true;
      if (this.initialStateTimer) {
        clearTimeout(this.initialStateTimer);
        this.initialStateTimer = null;
      }
    }
    const player = payload?.player ?? payload;
    const state =
      typeof payload?.state === 'string'
        ? (payload.state as string)
        : typeof player?.state === 'string'
          ? (player.state as string)
          : undefined;
    const volume =
      typeof player?.volume === 'number' ? (player.volume as number) : undefined;
    const muted =
      typeof player?.muted === 'boolean' ? (player.muted as boolean) : undefined;
    if (this.expectVolume && volume === undefined && !this.warnedMissingVolume) {
      log.warn('client/state missing volume while supported', { clientId: this.clientId });
      this.warnedMissingVolume = true;
    }
    if (this.expectMute && muted === undefined && !this.warnedMissingMute) {
      log.warn('client/state missing mute while supported', { clientId: this.clientId });
      this.warnedMissingMute = true;
    }

    const update: SendspinPlayerStateUpdate = {
      clientId: this.clientId,
      roles: this.roles,
      state,
      volume,
      muted,
    };

    if (this.hooks.onPlayerState) {
      try {
        this.hooks.onPlayerState(this, update);
      } catch (err) {
        log.error('onPlayerState hook error', { message: (err as Error).message });
      }
    }
  }

  private handleCommand(payload: any): void {
    const controller = payload?.controller ?? payload;
    const command =
      typeof controller?.command === 'string' ? (controller.command as string) : 'unknown';
    const volume =
      typeof controller?.volume === 'number' ? (controller.volume as number) : undefined;
    const mute = typeof controller?.mute === 'boolean' ? (controller.mute as boolean) : undefined;

    const cmd: SendspinGroupCommand = {
      clientId: this.clientId,
      roles: this.roles,
      command,
      volume,
      mute,
    };

    this.logClientMessage('client/command', {
      command,
      volume,
      mute,
    });

    if (this.hooks.onGroupCommand) {
      try {
        this.hooks.onGroupCommand(this, cmd);
      } catch (err) {
        log.error('onGroupCommand hook error', { message: (err as Error).message });
      }
    }
  }

  private handleGoodbye(payload: any): void {
    const reason = typeof payload?.reason === 'string' ? payload.reason : 'unknown';
    this.logClientMessage('client/goodbye', { reason }, 'info');
    try {
      this.ws.close(1000, 'client goodbye');
    } catch {
      /* ignore */
    }
  }

  private handleFormatRequest(payload: any): void {
    const playerReq = payload?.player;
    if (playerReq) {
      const codecRaw = typeof playerReq.codec === 'string' ? playerReq.codec : this.streamFormat.codec;
      const codec: PlayerFormat['codec'] =
        codecRaw === 'opus' ? 'opus' : codecRaw === 'flac' ? 'flac' : 'pcm';
      const requestedRate =
        typeof playerReq.sample_rate === 'number' ? playerReq.sample_rate : undefined;
      const requestedChannels =
        typeof playerReq.channels === 'number' ? playerReq.channels : undefined;
      const requestedBitDepth =
        typeof playerReq.bit_depth === 'number' ? playerReq.bit_depth : undefined;
      this.streamFormat = {
        codec,
        sampleRate: requestedRate ?? this.streamFormat.sampleRate,
        channels: requestedChannels ?? this.streamFormat.channels,
        bitDepth: requestedBitDepth ?? this.streamFormat.bitDepth,
      };
    }

    const artworkReq = payload?.artwork;
    if (artworkReq && typeof artworkReq.channel === 'number') {
      const idx = Math.floor(artworkReq.channel);
      if (idx < 0 || idx >= this.artworkChannels.length) {
        log.warn('client/stream request invalid artwork channel', {
          clientId: this.clientId,
          channel: artworkReq.channel,
          available: this.artworkChannels.length,
        });
        return;
      }
      const source: 'album' | 'artist' | 'none' =
        artworkReq.source === 'artist' ? 'artist' : artworkReq.source === 'none' ? 'none' : 'album';
      const format: 'jpeg' | 'png' | 'bmp' =
        artworkReq.format === 'png' ? 'png' : artworkReq.format === 'bmp' ? 'bmp' : 'jpeg';
      const width =
        typeof artworkReq.media_width === 'number'
          ? artworkReq.media_width
          : this.artworkChannels[idx]?.width ?? 800;
      const height =
        typeof artworkReq.media_height === 'number'
          ? artworkReq.media_height
          : this.artworkChannels[idx]?.height ?? 800;
      const next = { source, format, width, height };
      this.artworkChannels[idx] = next;
      this.sendArtworkStreamStart(this.artworkChannels);
    }

    if (this.hooks.onFormatChanged) {
      try {
        this.hooks.onFormatChanged(this, this.streamFormat);
      } catch (err) {
        log.warn('onFormatChanged hook failed', { message: (err as Error).message });
      }
    }

    this.sendStreamFormat();
  }

  private send(obj: any): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private sendBinary(buf: ArrayBufferLike | Buffer, options: { allowDrop?: boolean } = {}): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf as ArrayBufferLike);
    const buffered = typeof this.ws.bufferedAmount === 'number' ? this.ws.bufferedAmount : 0;
    if (options.allowDrop === true && buffered > this.maxBufferedSend) {
      this.backpressureDrops += 1;
      this.lastBackpressureBytes = buffered;
      this.lastBackpressureTs = Date.now();
      this.backpressureEvents.push(this.lastBackpressureTs);
      if (this.backpressureDrops === 1 || this.backpressureDrops % 25 === 0) {
        log.debug('sendspin backpressure: drop audio frame', {
          clientId: this.clientId,
          buffered,
          drops: this.backpressureDrops,
        });
      }
      return;
    }
    this.ws.send(buffer, { binary: true });
  }

  private applyPreferredStreamFormat(): void {
    const supportedFormats: any[] = Array.isArray(this.playerSupport?.supported_formats)
      ? this.playerSupport.supported_formats
      : [];
    if (!supportedFormats.length) return;

    const isSupported = (fmt: any): boolean =>
      fmt?.codec === 'opus' || fmt?.codec === 'flac' || fmt?.codec === 'pcm';
    const hasValidNumbers = (fmt: any): boolean =>
      typeof fmt.sample_rate === 'number' && fmt.sample_rate > 0
      && typeof fmt.channels === 'number' && fmt.channels > 0
      && typeof fmt.bit_depth === 'number' && fmt.bit_depth > 0;
    const preferred = supportedFormats.find((fmt) => isSupported(fmt) && hasValidNumbers(fmt));
    if (preferred) {
      const codec: PlayerFormat['codec'] =
        preferred.codec === 'opus' ? 'opus' : preferred.codec === 'flac' ? 'flac' : 'pcm';
      this.streamFormat = {
        codec,
        sampleRate: preferred.sample_rate,
        channels: preferred.channels,
        bitDepth: preferred.bit_depth,
      };
      log.info('Using client-preferred format', {
        clientId: this.clientId,
        codec: this.streamFormat.codec,
        sampleRate: this.streamFormat.sampleRate,
        channels: this.streamFormat.channels,
        bitDepth: this.streamFormat.bitDepth,
      });
      return;
    }
  }

  private sendStreamFormat(): void {
    const { codec, sampleRate, channels, bitDepth } = this.streamFormat;
    this.send({
      type: 'stream/start',
      payload: {
        player: {
          codec,
          sample_rate: sampleRate,
          channels,
          bit_depth: bitDepth,
        },
      },
    });
    this.activeStream = true;
  }

  public getStreamFormat(): PlayerFormat {
    return { ...this.streamFormat };
  }

  private logClientMessage(
    type: string,
    fields: Record<string, any>,
    level: 'info' | 'debug' | 'spam' = 'info',
  ): void {
    const base: Record<string, any> = {
      clientId: this.clientId ?? 'unknown',
      type,
      connection: this.connectionReason,
    };
    if (typeof this.connectionMeta.zoneId === 'number') {
      base.zone = this.connectionMeta.zoneId;
    }
    if (this.connectionMeta.playerId) {
      base.playerId = this.connectionMeta.playerId;
    }
    if (this.connectionMeta.remote) {
      base.remote = this.connectionMeta.remote;
    }
    const payload = Object.entries(fields).reduce<Record<string, any>>((acc, [key, value]) => {
      if (value !== undefined) {
        acc[key] = value;
      }
      return acc;
    }, {});
    const data = Object.keys(payload).length ? { ...base, ...payload } : base;
    if (level === 'spam') {
      log.spam('recv text', data);
    } else if (level === 'debug') {
      log.debug('recv text', data);
    } else {
      log.info('recv text', data);
    }
  }

  private applyConnectionContext(
    context: SendspinConnectionMeta & { reason?: 'cast-tunnel' },
  ): void {
    if (!context) return;
    if (context.reason) {
      this.connectionReason = context.reason;
    }
    this.connectionMeta.zoneId =
      typeof context.zoneId === 'number' ? context.zoneId : this.connectionMeta.zoneId;
    this.connectionMeta.playerId = context.playerId ?? this.connectionMeta.playerId;
    this.connectionMeta.tunnel = context.tunnel ?? this.connectionMeta.tunnel;
    this.connectionMeta.remote = context.remote ?? this.connectionMeta.remote;
  }

  private startInitialStateTimeout(): void {
    if (!this.roles.includes('player@v1')) {
      return;
    }
    if (this.initialStateReceived || this.initialStateTimer) {
      return;
    }
    this.initialStateTimer = setTimeout(() => {
      if (this.initialStateReceived) {
        return;
      }
      log.warn('client/hello missing required initial state; closing connection', {
        clientId: this.clientId ?? 'unknown',
      });
      try {
        this.ws.close(1008, 'initial state timeout');
      } catch {
        /* ignore */
      }
    }, 5000);
  }
}
