import type { IncomingMessage } from 'node:http';
import { networkInterfaces } from 'node:os';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';
import { createLogger } from '@/core/logging/logger';
import { audioOutputSettings, type AudioOutputSettings } from '@/modules/audio/utils/audioFormat';
import { audioManager } from '@/modules/audio/audioManager';

type SnapcastClient = {
  socket: WebSocket;
  buffer: Buffer;
  clientId: string | null;
  streamId: string;
  lastHelloId: number | null;
  connectedAt: number;
};

type ActiveStream = {
  streamId: string;
  zoneId: number;
  output: AudioOutputSettings;
  bytesPerFrame: number;
  nextTimestampUs: number;
  chunkBuffer: Buffer;
  source: NodeJS.ReadableStream;
  cleanup: () => void;
};

const BASE_HEADER_SIZE = 26; // 3x uint16 + 2x tv(int32,int32) + size(uint32), little endian
const CHUNK_MS = 10;
const MAX_BUFFER_MS = 500;
const INITIAL_LEAD_US = 250_000; // ~250ms lead to avoid initial “old chunk” drops
// Snapclient uses a steady clock (steadytimeofday). Approximate that by anchoring
// our high-res monotonic clock to the host uptime so both sides share the same epoch.
const HR_TO_UPTIME_OFFSET_NS =
  BigInt(Math.round(os.uptime() * 1_000_000_000)) - process.hrtime.bigint();

/**
 * Central Snapcast-compatible server (WebSocket only).
 * Listens on /snapcast via the shared HTTP server upgrade path.
 */
class SnapcastCore {
  private readonly log = createLogger('Http', 'Snapcast');
  private readonly wsServer = new WebSocketServer({ noServer: true });
  private readonly rpcServer = new WebSocketServer({ noServer: true });
  private readonly rpcClients = new Set<WebSocket>();
  private readonly clients = new Set<SnapcastClient>();
  private nextMessageId = 0;
  private streams = new Map<string, ActiveStream>();
  private clientToStream = new Map<string, string>();
  private rpcInterval: NodeJS.Timeout | null = null;
  private readonly streamSignatures = new Map<string, string>();

  constructor() {
    this.wsServer.on('connection', (socket, req) => {
      this.handleConnection(socket, req);
    });
    this.rpcServer.on('connection', (socket) => {
      this.rpcClients.add(socket);
      this.startRpcUpdates();
      socket.on('message', (data: RawData) => this.handleRpcMessage(socket, data));
      socket.on('close', () => {
        this.rpcClients.delete(socket);
        this.stopRpcUpdatesIfIdle();
      });
      socket.on('error', () => {
        this.rpcClients.delete(socket);
        this.stopRpcUpdatesIfIdle();
      });
    });
  }

  public handleUpgrade(request: IncomingMessage, socket: any, head: Buffer): boolean {
    const rawPath = (request.url ?? '').split('?')[0] || '/';
    const path = rawPath === '/' ? '/snapcast' : rawPath;
    const isStreamPath = path === '/snapcast' || path === '/stream' || path.startsWith('/snapcast/') || path.startsWith('/stream/');
    const isRpcPath = path === '/snapcast/jsonrpc' || path === '/jsonrpc';
    if (!isStreamPath && !isRpcPath) {
      return false;
    }
    if (isRpcPath) {
      this.rpcServer.handleUpgrade(request, socket, head, (ws) => {
        this.rpcServer.emit('connection', ws, request);
      });
      return true;
    }
    this.wsServer.handleUpgrade(request, socket, head, (ws) => {
      this.wsServer.emit('connection', ws, request);
    });
    return true;
  }

  public close(): void {
    this.clients.forEach((client) => client.socket.close());
    this.clients.clear();
    this.wsServer.close();
    this.rpcServer.close();
    this.rpcClients.clear();
    if (this.rpcInterval) {
      clearInterval(this.rpcInterval);
      this.rpcInterval = null;
    }
    this.clearStream();
  }

  public listClients(): Array<{
    clientId: string;
    streamId: string;
    connected: boolean;
    connectedAt: number;
    lastHelloId: number | null;
  }> {
    return Array.from(this.clients).map((c) => ({
      clientId: c.clientId ?? '',
      streamId: c.streamId,
      connected: c.socket.readyState === WebSocket.OPEN,
      connectedAt: c.connectedAt,
      lastHelloId: c.lastHelloId,
    }));
  }

  public setClientStream(clientId: string, streamId: string): { updated: boolean; connected: boolean } {
    if (!clientId || !streamId) {
      return { updated: false, connected: false };
    }
    this.clientToStream.set(clientId, streamId);
    let connected = false;
    let pushed = false;
    for (const client of this.clients) {
      if (client.clientId === clientId) {
        const previousStream = client.streamId;
        connected = true;
        if (client.streamId !== streamId) {
          client.streamId = streamId;
        }
        const output =
          this.streams.get(streamId)?.output ??
          this.streams.values().next().value?.output ??
          audioOutputSettings;
        this.sendSettingsAndHeader(client, output, client.lastHelloId ?? 0);
        pushed = true;
        if (previousStream !== streamId) {
          this.updateFlowControl(previousStream);
        }
      }
    }
    this.log.info('snapcast client stream mapped', { clientId, streamId, connected, pushed });
    this.updateFlowControl(streamId);
    return { updated: true, connected };
  }

  public setStream(
    streamId: string,
    zoneId: number,
    output: AudioOutputSettings,
    stream: NodeJS.ReadableStream,
    clientIds: string[] = [],
  ): void {
    const hadExisting =
      this.streams.has(streamId) ||
      Array.from(this.clients).some((client) => client.streamId === streamId);
    this.clearStream(streamId);
    const bytesPerFrame = (output.pcmBitDepth / 8) * output.channels;
    const targetBytes = Math.max(
      bytesPerFrame,
      Math.floor((output.sampleRate * CHUNK_MS) / 1000) * bytesPerFrame,
    );
    const onData = (chunk: Buffer) => {
      const active = this.streams.get(streamId);
      if (!active) return;
      active.chunkBuffer = Buffer.concat([active.chunkBuffer, chunk]);
      while (active.chunkBuffer.length >= targetBytes) {
        const payload = active.chunkBuffer.slice(0, targetBytes);
        active.chunkBuffer = active.chunkBuffer.slice(targetBytes);
        this.broadcastWireChunk(streamId, payload);
      }
    };
    const onError = (error: Error) => {
      this.log.debug('snapcast stream error', { zoneId, message: error.message });
    };
    const onClose = () => {
      this.log.debug('snapcast stream closed', { zoneId });
      this.clearStream(streamId);
    };

    stream.on('data', onData);
    stream.once('error', onError);
    stream.once('close', onClose);

    const active: ActiveStream = {
      streamId,
      zoneId,
      output,
      bytesPerFrame,
      nextTimestampUs: this.nowUs() + INITIAL_LEAD_US,
      chunkBuffer: Buffer.alloc(0),
      source: stream,
      cleanup: () => {
        stream.off('data', onData);
        stream.off('error', onError);
        stream.off('close', onClose);
        if (typeof (stream as any).destroy === 'function') {
          (stream as any).destroy();
        }
      },
    };
    this.streams.set(streamId, active);

    // Register client mappings for this stream.
    clientIds.forEach((id) => {
      this.clientToStream.set(id, streamId);
    });

    // Reassign already-connected clients whose ID maps to this stream.
    for (const client of this.clients) {
      if (clientIds.includes(client.clientId ?? '')) {
        client.streamId = streamId;
        this.log.info('snapcast client reassigned to stream', { clientId: client.clientId, streamId });
      }
    }

    this.log.info('snapcast stream registered', {
      streamId,
      zoneId,
      sampleRate: output.sampleRate,
      channels: output.channels,
      bitDepth: output.pcmBitDepth,
      clientIds,
    });

    // Notify already connected clients for this stream.
    this.pushSettingsToClients(streamId, output);

    // Do not force-close unmapped clients; allow them to keep their connection and request streams explicitly.

    // Pause stream flow until at least one client is connected to this stream.
    this.updateFlowControl(streamId);
    this.streamSignatures.delete(streamId);
  }

  public clearStream(zoneId?: number | string): void {
    if (zoneId != null) {
      const zoneNum = typeof zoneId === 'string' ? Number(zoneId) : zoneId;
      for (const [id, active] of this.streams.entries()) {
        if (active.zoneId === zoneNum || id === String(zoneId)) {
          active.cleanup();
          this.streams.delete(id);
          // Drop client mappings that pointed to this stream.
          for (const [clientId, streamId] of this.clientToStream.entries()) {
            if (streamId === id) {
              this.clientToStream.delete(clientId);
            }
          }
        }
      }
      return;
    }
    this.streams.forEach((active) => active.cleanup());
    this.streams.clear();
    this.clientToStream.clear();
  }

  private handleConnection(socket: WebSocket, _req: IncomingMessage | undefined): void {
    const requested = this.extractStreamId(_req?.url ?? '/snapcast') ?? 'default';
    const streamId = this.resolveStreamId(requested);
    const client: SnapcastClient = {
      socket,
      buffer: Buffer.alloc(0),
      clientId: null,
      streamId,
      lastHelloId: null,
      connectedAt: Date.now(),
    };
    this.clients.add(client);
    this.log.debug('snapcast ws connection opened', { streamId });
    socket.on('message', (data: Buffer) => {
      this.consumeData(client, Buffer.isBuffer(data) ? data : Buffer.from(data));
    });
    socket.on('close', () => {
      this.clients.delete(client);
      this.updateFlowControl(client.streamId);
    });
    socket.on('error', (error) => {
      this.log.debug('snapcast client error', { message: (error as Error).message });
      this.clients.delete(client);
      this.updateFlowControl(client.streamId);
    });
    this.updateFlowControl(client.streamId);
  }

  private consumeData(client: SnapcastClient, data: Buffer): void {
    client.buffer = Buffer.concat([client.buffer, data]);
    while (client.buffer.length >= BASE_HEADER_SIZE) {
      const header = this.parseHeader(client.buffer);
      if (!header) {
        return;
      }
      const totalLength = BASE_HEADER_SIZE + header.size;
      if (client.buffer.length < totalLength) {
        return;
      }
      const body = client.buffer.slice(BASE_HEADER_SIZE, totalLength);
      client.buffer = client.buffer.slice(totalLength);
      this.handleMessage(client, header, body);
    }
  }

  private parseHeader(buffer: Buffer): {
    type: number;
    id: number;
    refersTo: number;
    sent: { sec: number; usec: number };
    received: { sec: number; usec: number };
    size: number;
  } | null {
    try {
      const type = buffer.readUInt16LE(0);
      const id = buffer.readUInt16LE(2);
      const refersTo = buffer.readUInt16LE(4);
      const sentSec = buffer.readInt32LE(6);
      const sentUsec = buffer.readInt32LE(10);
      const now = this.nowTv();
      const size = buffer.readUInt32LE(22);
      return {
        type,
        id,
        refersTo,
        sent: { sec: sentSec, usec: sentUsec },
        // Per reference snapserver, stamp server receive time instead of trusting the client payload.
        received: now,
        size,
      };
    } catch (error) {
      this.log.warn('failed to parse snapcast header', { message: (error as Error).message });
      return null;
    }
  }

  private handleMessage(
    client: SnapcastClient,
    header: { type: number; id: number; refersTo: number; sent: { sec: number; usec: number }; received: { sec: number; usec: number }; size: number },
    body: Buffer,
  ): void {
    switch (header.type) {
      case 5: // Hello
        this.handleHello(client, header, body);
        break;
      case 4: // Time
        this.handleTime(client, header);
        break;
      default:
        // Ignore unsupported types.
        break;
    }
  }

  private handleHello(client: SnapcastClient, header: { id: number }, body: Buffer): void {
    try {
      const jsonLen = body.readUInt32LE(0);
      const jsonStr = body.slice(4, 4 + jsonLen).toString('utf8');
      const parsed = JSON.parse(jsonStr) as { ID?: string; MAC?: string; Instance?: number };
      const instance = typeof parsed.Instance === 'number' && parsed.Instance > 1 ? `#${parsed.Instance}` : '';
      const previousStream = client.streamId;
      client.clientId = `${parsed.ID || parsed.MAC || 'client'}${instance}`;
      client.lastHelloId = header.id;
      this.log.info('snapcast client connected', { clientId: client.clientId, requestedStream: client.streamId });
      const mappedStream = this.clientToStream.get(client.clientId);
      if (mappedStream) {
        client.streamId = mappedStream;
        this.log.info('snapcast client mapped to stream', { clientId: client.clientId, streamId: mappedStream });
      }
      if (previousStream !== client.streamId) {
        this.updateFlowControl(previousStream);
      }
    } catch (error) {
      this.log.warn('failed to parse snapcast Hello', { message: (error as Error).message });
    }

    const activeStream = this.streams.get(client.streamId);
    const activeOutput = activeStream?.output ?? audioOutputSettings;

    this.sendSettingsAndHeader(client, activeOutput, header.id);
    this.updateFlowControl(client.streamId);
  }

  private handleTime(client: SnapcastClient, header: { id: number; sent: { sec: number; usec: number }; received: { sec: number; usec: number } }): void {
    // Snapcast Time: latency = server_received - client_sent.
    const sentUs = header.sent.sec * 1_000_000 + header.sent.usec;
    const recvUs = header.received.sec * 1_000_000 + header.received.usec;
    const deltaUs = recvUs - sentUs;
    const latencySec = Math.trunc(deltaUs / 1_000_000);
    const latencyUsec = Math.trunc(deltaUs - latencySec * 1_000_000);
    const payload = Buffer.alloc(8);
    payload.writeInt32LE(latencySec, 0);
    payload.writeInt32LE(latencyUsec, 4);
    const message = this.encodeMessage(4, this.nextId(), header.id, payload);
    client.socket.send(message);
  }

  private broadcastWireChunk(streamId: string, payload: Buffer): void {
    const active = this.streams.get(streamId);
    if (!active || this.clients.size === 0) {
      return;
    }
    // Derive timestamp based on running stream clock to keep steady playout.
    const frames = Math.max(1, Math.floor(payload.length / Math.max(1, active.bytesPerFrame)));
    const durationUs = Math.floor((frames * 1_000_000) / Math.max(1, active.output.sampleRate));
    const nowUs = this.nowUs();
    let tsUs =
      active.nextTimestampUs && Number.isFinite(active.nextTimestampUs) ? active.nextTimestampUs : nowUs + INITIAL_LEAD_US;
    // If we fell behind (e.g., after a pause or reconnect), jump forward to avoid sending stale chunks.
    if (tsUs < nowUs) {
      tsUs = nowUs + INITIAL_LEAD_US;
    }
    active.nextTimestampUs = tsUs + durationUs;
    const timestamp = {
      sec: Math.floor(tsUs / 1_000_000),
      usec: Math.floor(tsUs - Math.floor(tsUs / 1_000_000) * 1_000_000),
    };
    const chunkPayload = Buffer.alloc(8 + 4 + payload.length);
    chunkPayload.writeInt32LE(timestamp.sec, 0);
    chunkPayload.writeInt32LE(timestamp.usec, 4);
    chunkPayload.writeUInt32LE(payload.length, 8);
    payload.copy(chunkPayload, 12);
    const message = this.encodeMessage(2, this.nextId(), 0, chunkPayload);
    for (const client of this.clients) {
      if (client.socket.readyState === WebSocket.OPEN && client.streamId === streamId) {
        client.socket.send(message);
      }
    }
  }

  private encodeJsonMessage(type: number, refersTo: number, payload: Record<string, unknown>): Buffer {
    const json = JSON.stringify(payload);
    const body = Buffer.alloc(4 + Buffer.byteLength(json));
    body.writeUInt32LE(Buffer.byteLength(json), 0);
    body.write(json, 4);
    return this.encodeMessage(type, this.nextId(), refersTo, body);
  }

  private buildPcmCodecHeader(sampleRate: number, channels: number, bitDepth: number): Buffer {
    const wav = this.encodeWavHeader(sampleRate, channels, bitDepth);
    const payload = Buffer.alloc(4 + wav.length + 4 + Buffer.byteLength('pcm'));
    payload.writeUInt32LE(Buffer.byteLength('pcm'), 0);
    payload.write('pcm', 4);
    payload.writeUInt32LE(wav.length, 4 + Buffer.byteLength('pcm'));
    wav.copy(payload, 8 + Buffer.byteLength('pcm'));
    return this.encodeMessage(1, this.nextId(), 0, payload);
  }

  private encodeWavHeader(sampleRate: number, channels: number, bitDepth: number): Buffer {
    const blockAlign = (channels * bitDepth) / 8;
    const byteRate = sampleRate * blockAlign;
    const buffer = Buffer.alloc(44);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitDepth, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(0, 40);
    return buffer;
  }

  private encodeMessage(type: number, id: number, refersTo: number, payload: Buffer): Buffer {
    const safeType = type & 0xffff;
    const safeId = id & 0xffff;
    const safeRefersTo = refersTo & 0xffff;
    const header = Buffer.alloc(BASE_HEADER_SIZE);
    header.writeUInt16LE(safeType, 0);
    header.writeUInt16LE(safeId, 2);
    header.writeUInt16LE(safeRefersTo, 4);
    const now = this.nowTv();
    header.writeInt32LE(now.sec, 6);
    header.writeInt32LE(now.usec, 10);
    header.writeInt32LE(now.sec, 14);
    header.writeInt32LE(now.usec, 18);
    header.writeUInt32LE(payload.length, 22);
    return Buffer.concat([header, payload]);
  }

  private nextId(): number {
    this.nextMessageId = (this.nextMessageId % 0xffff) + 1;
    return this.nextMessageId;
  }

  private nowTv(): { sec: number; usec: number } {
    const us = this.nowUs();
    const sec = Math.floor(us / 1_000_000);
    const usec = Math.floor(us - sec * 1_000_000);
    return { sec, usec };
  }

  private nowUs(): number {
    // Monotonic microseconds anchored to host uptime to approximate steadytimeofday.
    const ns = process.hrtime.bigint() + HR_TO_UPTIME_OFFSET_NS;
    return Math.trunc(Number(ns / 1_000n));
  }

  private extractStreamId(url: string): string | null {
    const safeUrl = url || '/snapcast';
    let streamParam: string | null = null;
    try {
      const u = new URL(safeUrl, 'http://localhost');
      streamParam = u.searchParams.get('stream');
    } catch {
      // ignore
    }
    const path = safeUrl.split('?')[0] || '/snapcast';
    if (streamParam && streamParam.trim()) {
      return streamParam.trim();
    }
    if (path.startsWith('/stream/')) {
      return decodeURIComponent(path.slice('/stream/'.length)) || null;
    }
    if (path.startsWith('/snapcast/')) {
      return decodeURIComponent(path.slice('/snapcast/'.length)) || null;
    }
    return 'default';
  }

  private resolveStreamId(requested: string): string {
    if (this.streams.has(requested)) {
      return requested;
    }
    // Keep the requested id so late-registered streams (per-zone) do not get rerouted to another zone.
    this.log.debug('snapcast resolveStreamId: stream not found, keeping requested', { requested });
    return requested;
  }

  private pushSettingsToClients(streamId: string, output: AudioOutputSettings): void {
    let pushed = 0;
    for (const client of this.clients) {
      if (client.streamId === streamId && client.socket.readyState === WebSocket.OPEN) {
        this.sendSettingsAndHeader(client, output, client.lastHelloId ?? 0);
        pushed += 1;
      }
    }
    this.log.debug('snapcast pushed settings to clients', { streamId, count: pushed });
  }

  private sendSettingsAndHeader(
    client: SnapcastClient,
    output: AudioOutputSettings,
    refersTo: number,
  ): void {
    const settings = this.encodeJsonMessage(3, refersTo, {
      bufferMs: (() => {
        const computed = output.prebufferBytes
          ? Math.round(
              (output.prebufferBytes / (output.sampleRate * output.channels * (output.pcmBitDepth / 8))) * 1000,
            )
          : 0;
        if (!Number.isFinite(computed) || computed <= 0) {
          return MAX_BUFFER_MS;
        }
        return Math.min(computed, MAX_BUFFER_MS);
      })(),
      latency: 0,
      volume: 100,
      muted: false,
    });
    client.socket.send(settings);

    const wavHeader = this.buildPcmCodecHeader(output.sampleRate, output.channels, output.pcmBitDepth);
    client.socket.send(wavHeader);
  }

  private updateFlowControl(streamId: string): void {
    const active = this.streams.get(streamId);
    if (!active) return;
    const hasClient = Array.from(this.clients).some(
      (client) => client.streamId === streamId && client.socket.readyState === WebSocket.OPEN,
    );
    if (!hasClient && active.chunkBuffer.length > 0) {
      // Drop any queued audio when nobody is listening to avoid unbounded buffers.
      active.chunkBuffer = Buffer.alloc(0);
      active.nextTimestampUs = this.nowUs() + INITIAL_LEAD_US;
      this.log.debug('snapcast stream drained (no clients)', { streamId });
    }
  }

  private handleRpcMessage(socket: WebSocket, raw: RawData): void {
    let payload: any;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') return;
    if (payload.method === 'Server.GetStatus') {
      const result = this.buildStatus();
      socket.send(JSON.stringify({ id: payload.id ?? null, jsonrpc: '2.0', result }));
      return;
    }
    // Unsupported; respond with basic error so clients don't hang.
    if (payload.id !== undefined) {
      socket.send(
        JSON.stringify({
          id: payload.id,
          jsonrpc: '2.0',
          error: { code: -32601, message: 'Method not found' },
        }),
      );
    }
  }

  private startRpcUpdates(): void {
    if (this.rpcInterval) return;
    this.rpcInterval = setInterval(() => this.broadcastUpdates(), 1000);
  }

  private stopRpcUpdatesIfIdle(): void {
    if (this.rpcClients.size === 0 && this.rpcInterval) {
      clearInterval(this.rpcInterval);
      this.rpcInterval = null;
    }
  }

  private broadcastUpdates(): void {
    if (this.rpcClients.size === 0) return;
    const status = this.buildStatus();
    const changed = status.streams.some((stream: any) => {
      const sig = JSON.stringify({
        id: stream.id,
        playbackStatus: stream.properties?.playbackStatus,
        position: stream.properties?.position,
        metadata: stream.properties?.metadata,
      });
      const prev = this.streamSignatures.get(stream.id);
      if (prev !== sig) {
        this.streamSignatures.set(stream.id, sig);
        return true;
      }
      return false;
    });
    if (!changed) return;
    const notification = {
      jsonrpc: '2.0',
      method: 'Server.OnUpdate',
      params: { server: status },
    };
    const payload = JSON.stringify(notification);
    for (const client of Array.from(this.rpcClients)) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  private buildStatus(): any {
    const serverMeta = this.buildServerMeta();
    const streams = Array.from(this.streams.values()).map((stream) =>
      this.buildStreamStatus(stream),
    );
    const groups = Array.from(this.streams.values()).map((stream) =>
      this.buildGroupStatus(stream),
    );
    return {
      server: serverMeta,
      streams,
      groups,
    };
  }

  private buildServerMeta(): any {
    const hostName = os.hostname();
    const ip = this.pickLocalAddress();
    return {
      host: {
        arch: os.arch(),
        ip,
        mac: '',
        name: hostName,
        os: os.platform(),
      },
      snapserver: {
        controlProtocolVersion: 1,
        name: 'Lox Audio Server',
        protocolVersion: 1,
        version: '0.0.0',
      },
    };
  }

  private buildStreamStatus(active: ActiveStream): any {
    const session = audioManager.getSession(active.zoneId);
    const meta = session?.metadata;
    const metadata = meta
      ? {
          title: meta.title ?? undefined,
          artist: meta.artist ? [meta.artist] : undefined,
          album: meta.album ?? undefined,
          artUrl: meta.coverurl ?? session?.stream?.coverUrl,
          duration: meta.duration ?? session?.duration ?? undefined,
        }
      : undefined;
    const playbackStatus =
      session?.state === 'playing' ? 'playing' : session?.state === 'paused' ? 'paused' : 'stopped';
    const position = session?.elapsed ?? undefined;
    return {
      id: active.streamId,
      status: playbackStatus === 'playing' ? 'playing' : 'idle',
      properties: {
        canControl: false,
        canGoNext: false,
        canGoPrevious: false,
        canPause: false,
        canPlay: false,
        canSeek: false,
        loopStatus: 'none',
        shuffle: false,
        volume: 100,
        playbackStatus,
        position,
        metadata,
      },
      uri: {
        raw: `ws://${this.pickLocalAddress()}:${process.env.HTTP_PORT ?? ''}/snapcast/${active.streamId}`,
        scheme: 'ws',
        host: this.pickLocalAddress(),
        path: `/snapcast/${active.streamId}`,
        fragment: '',
        query: {},
      },
    };
  }

  private buildGroupStatus(active: ActiveStream): any {
    const clients = Array.from(this.clients)
      .filter((c) => c.streamId === active.streamId)
      .map((c) => ({
        id: c.clientId ?? 'unknown',
        connected: c.socket.readyState === WebSocket.OPEN,
        config: {
          instance: 1,
          latency: 0,
          name: c.clientId ?? '',
          volume: { muted: false, percent: 100 },
        },
        host: {
          arch: 'web',
          ip: '',
          mac: '',
          name: c.clientId ?? 'client',
          os: '',
        },
        snapclient: { name: 'snapclient', protocolVersion: 2, version: '0.0.0' },
        lastSeen: { sec: Math.floor(Date.now() / 1000), usec: 0 },
      }));
    return {
      id: active.streamId,
      name: '',
      muted: false,
      stream_id: active.streamId,
      clients,
    };
  }

  private pickLocalAddress(): string {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal && net.address) {
          return net.address;
        }
      }
    }
    return '127.0.0.1';
  }
}

export const snapcastCore = new SnapcastCore();
