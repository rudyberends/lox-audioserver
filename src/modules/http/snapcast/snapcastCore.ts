import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';
import { createLogger } from '@/core/logging/logger';
import { audioOutputSettings, type AudioOutputSettings } from '@/modules/audio/utils/audioFormat';
import { audioManager } from '@/modules/audio/audioManager';
import { zoneManager } from '@/modules/zones/zoneManager';

type SnapcastClient = {
  socket: WebSocket;
  buffer: Buffer;
  clientId: string | null;
  requestedStreamId: string;
  streamId: string;
  lastHelloId: number | null;
  connectedAt: number;
};

type SnapcastVolume = {
  muted: boolean;
  percent: number;
};

type SnapcastClientConfig = {
  instance: number;
  latency: number;
  name: string;
  volume: SnapcastVolume;
  host: {
    arch: string;
    ip: string;
    mac: string;
    name: string;
    os: string;
  };
  snapclient: {
    name: string;
    protocolVersion: number;
    version: string;
  };
};

type SnapcastGroupState = {
  id: string;
  name: string;
  muted: boolean;
  streamId: string;
  clientIds: Set<string>;
};

type RpcStream = {
  id: string;
  uri: string;
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
const CHUNK_MS = 20;
const MAX_BUFFER_MS = 500;
const INITIAL_LEAD_US = 0;
const MAX_MESSAGE_SIZE = 1_000_000;
// Snapclient uses a steady clock (steadytimeofday). Use the monotonic clock directly.

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
  private readonly clientConfigs = new Map<string, SnapcastClientConfig>();
  private readonly groupConfigs = new Map<string, SnapcastGroupState>();
  private readonly clientToGroup = new Map<string, string>();
  private readonly streamMuteSnapshots = new Map<string, number>();
  private readonly rpcStreams = new Map<string, RpcStream>();

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
        connected = true;
        if (client.streamId !== streamId) {
          this.updateClientStream(client, streamId);
        }
        const output =
          this.streams.get(streamId)?.output ??
          this.streams.values().next().value?.output ??
          audioOutputSettings;
        this.sendSettings(client, output, 0, true);
        pushed = true;
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
    const bytesPerFrame = (output.pcmBitDepth / 8) * output.channels;
    const targetBytes = Math.max(
      bytesPerFrame,
      Math.floor((output.sampleRate * CHUNK_MS) / 1000) * bytesPerFrame,
    );
    const existing = this.streams.get(streamId);
    if (existing && existing.source === stream) {
      // Reuse the active stream when only the client mapping or output metadata changes.
      const formatChanged =
        existing.output.sampleRate !== output.sampleRate ||
        existing.output.channels !== output.channels ||
        existing.output.pcmBitDepth !== output.pcmBitDepth;
      existing.zoneId = zoneId;
      existing.output = output;
      existing.bytesPerFrame = bytesPerFrame;
      if (formatChanged) {
        existing.nextTimestampUs = 0;
        existing.chunkBuffer = Buffer.alloc(0);
      } else if (existing.nextTimestampUs < this.nowUs()) {
        existing.nextTimestampUs = 0;
      }

      clientIds.forEach((id) => {
        this.clientToStream.set(id, streamId);
      });
      for (const client of this.clients) {
        if (clientIds.includes(client.clientId ?? '')) {
          this.updateClientStream(client, streamId);
          this.log.info('snapcast client reassigned to stream', { clientId: client.clientId, streamId });
        }
      }
      this.log.info('snapcast stream updated', {
        streamId,
        zoneId,
        sampleRate: output.sampleRate,
        channels: output.channels,
        bitDepth: output.pcmBitDepth,
        clientIds,
      });
      this.pushSettingsToClients(streamId, output);
      this.updateFlowControl(streamId);
      this.streamSignatures.delete(streamId);
      return;
    }
    const hadExisting =
      this.streams.has(streamId) ||
      Array.from(this.clients).some((client) => client.streamId === streamId);
    this.clearStream(streamId);
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
      nextTimestampUs: 0,
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
        this.updateClientStream(client, streamId);
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

  public setClientVolumes(clientIds: string[], volume: number, muted?: boolean): void {
    if (!clientIds.length) return;
    const clamped = Math.min(100, Math.max(0, Math.round(volume)));
    for (const clientId of clientIds) {
      this.applyClientVolume(clientId, clamped, muted);
    }
    this.sendServerUpdate();
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
      requestedStreamId: requested,
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
      if (client.clientId) {
        this.sendClientNotification('Client.OnDisconnect', {
          client: this.buildClientStatus(client, false),
          id: client.clientId,
        });
      }
      this.clients.delete(client);
      this.updateFlowControl(client.streamId);
      this.sendServerUpdate();
    });
    socket.on('error', (error) => {
      this.log.debug('snapcast client error', { message: (error as Error).message });
      if (client.clientId) {
        this.sendClientNotification('Client.OnDisconnect', {
          client: this.buildClientStatus(client, false),
          id: client.clientId,
        });
      }
      this.clients.delete(client);
      this.updateFlowControl(client.streamId);
      this.sendServerUpdate();
    });
    this.updateFlowControl(client.streamId);
  }

  private consumeData(client: SnapcastClient, data: Buffer): void {
    client.buffer = Buffer.concat([client.buffer, data]);
    while (client.buffer.length >= BASE_HEADER_SIZE) {
      const header = this.parseHeader(client.buffer);
      if (!header) {
        this.terminateClient(client, 'invalid-header');
        return;
      }
      if (header.type > 8) {
        this.terminateClient(client, 'unknown-message-type', { type: header.type });
        return;
      }
      if (header.size > MAX_MESSAGE_SIZE) {
        this.terminateClient(client, 'message-too-large', { size: header.size });
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

  private terminateClient(client: SnapcastClient, reason: string, details?: Record<string, unknown>): void {
    this.log.warn('snapcast client disconnected', {
      reason,
      clientId: client.clientId,
      streamId: client.streamId,
      ...details,
    });
    client.buffer = Buffer.alloc(0);
    try {
      client.socket.close();
    } catch {
      /* ignore */
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
      case 7: // Client Info
        this.handleClientInfo(client, body);
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
      const parsed = JSON.parse(jsonStr) as {
        ID?: string;
        MAC?: string;
        Instance?: number;
        Arch?: string;
        HostName?: string;
        OS?: string;
        Version?: string;
        ClientName?: string;
        SnapStreamProtocolVersion?: number;
      };
      const instance = typeof parsed.Instance === 'number' && parsed.Instance > 1 ? `#${parsed.Instance}` : '';
      client.clientId = `${parsed.ID || parsed.MAC || 'client'}${instance}`;
      client.lastHelloId = header.id;
      const config = this.ensureClientConfig(client.clientId, parsed.Instance);
      if (typeof parsed.Arch === 'string') {
        config.host.arch = parsed.Arch;
      }
      if (typeof parsed.HostName === 'string') {
        config.host.name = parsed.HostName;
      }
      if (typeof parsed.OS === 'string') {
        config.host.os = parsed.OS;
      }
      if (typeof parsed.MAC === 'string') {
        config.host.mac = parsed.MAC;
      }
      const remoteIp = (client.socket as any)?._socket?.remoteAddress;
      if (typeof remoteIp === 'string') {
        config.host.ip = remoteIp;
      }
      if (typeof parsed.ClientName === 'string') {
        config.snapclient.name = parsed.ClientName;
      }
      if (typeof parsed.Version === 'string') {
        config.snapclient.version = parsed.Version;
      }
      if (typeof parsed.SnapStreamProtocolVersion === 'number') {
        config.snapclient.protocolVersion = parsed.SnapStreamProtocolVersion;
      }
      this.log.info('snapcast client connected', { clientId: client.clientId, requestedStream: client.streamId });
      const mappedStream = this.clientToStream.get(client.clientId);
      if (mappedStream) {
        this.updateClientStream(client, mappedStream);
        this.log.info('snapcast client mapped to stream', { clientId: client.clientId, streamId: mappedStream });
      }
      if (client.clientId) {
        this.applyZoneVolumeToClient(client.clientId, client.streamId);
      }
      if (client.clientId) {
        this.ensureGroupForClient(client.clientId, client.streamId);
        this.sendClientNotification('Client.OnConnect', {
          client: this.buildClientStatus(client, true),
          id: client.clientId,
        });
        this.sendServerUpdate();
      }
    } catch (error) {
      this.log.warn('failed to parse snapcast Hello', { message: (error as Error).message });
    }

    const activeStream = this.streams.get(client.streamId);
    const activeOutput = activeStream?.output ?? audioOutputSettings;

    this.sendSettings(client, activeOutput, header.id, true);
    this.updateFlowControl(client.streamId);
  }

  private handleClientInfo(client: SnapcastClient, body: Buffer): void {
    try {
      const jsonLen = body.readUInt32LE(0);
      const jsonStr = body.slice(4, 4 + jsonLen).toString('utf8');
      const parsed = JSON.parse(jsonStr) as { volume?: number; muted?: boolean };
      const clientId = client.clientId;
      if (!clientId) {
        return;
      }
      const config = this.ensureClientConfig(clientId);
      if (typeof parsed.volume === 'number' && Number.isFinite(parsed.volume)) {
        config.volume.percent = Math.min(100, Math.max(0, Math.round(parsed.volume)));
      }
      if (typeof parsed.muted === 'boolean') {
        config.volume.muted = parsed.muted;
      }
      this.sendClientNotification('Client.OnVolumeChanged', {
        id: clientId,
        volume: { muted: config.volume.muted, percent: config.volume.percent },
      });
      this.sendServerUpdate();
    } catch (error) {
      this.log.warn('failed to parse snapcast client info', { message: (error as Error).message });
    }
  }

  private applyClientVolume(clientId: string, volume: number, muted?: boolean): void {
    if (!clientId) return;
    const config = this.ensureClientConfig(clientId);
    config.volume.percent = Math.min(100, Math.max(0, Math.round(volume)));
    if (typeof muted === 'boolean') {
      config.volume.muted = muted;
    }
    const client = this.findClientById(clientId);
    if (client && client.socket.readyState === WebSocket.OPEN) {
      const output =
        this.streams.get(client.streamId)?.output ??
        this.streams.values().next().value?.output ??
        audioOutputSettings;
      this.sendSettings(client, output, 0, false);
    }
    this.sendClientNotification('Client.OnVolumeChanged', {
      id: clientId,
      volume: { muted: config.volume.muted, percent: config.volume.percent },
    });
  }

  private applyZoneVolumeToClient(clientId: string, streamId: string): void {
    const active = this.streams.get(streamId);
    if (!active) {
      return;
    }
    const zoneVolume = zoneManager.getZoneState(active.zoneId)?.volume;
    if (typeof zoneVolume !== 'number' || !Number.isFinite(zoneVolume)) {
      return;
    }
    const config = this.ensureClientConfig(clientId);
    config.volume.percent = Math.min(100, Math.max(0, Math.round(zoneVolume)));
  }

  private handleStreamAdd(
    params: any,
    reply: (result: any) => any,
    error: (code: number, message: string) => any,
  ): any {
    const streamUri = typeof params.streamUri === 'string' ? params.streamUri : '';
    if (!streamUri) {
      return error(-32602, 'Invalid params');
    }
    const parsed = this.parseStreamUri(streamUri);
    if (!parsed || !parsed.id) {
      return error(-32602, 'Invalid params');
    }
    const streamId = parsed.id;
    this.rpcStreams.set(streamId, { id: streamId, uri: streamUri });
    this.getOrCreateGroup(streamId, streamId);
    this.sendServerUpdate();
    return reply({ stream_id: streamId });
  }

  private parseStreamUri(uri: string): {
    id: string;
    scheme: string;
    host: string;
    path: string;
    fragment: string;
    query: Record<string, string>;
  } | null {
    try {
      const url = new URL(uri);
      const query: Record<string, string> = {};
      url.searchParams.forEach((value, key) => {
        query[key] = value;
      });
      const name = url.searchParams.get('name') ?? url.searchParams.get('stream') ?? '';
      const pathTail = url.pathname ? url.pathname.split('/').filter(Boolean).pop() ?? '' : '';
      const id = (name || pathTail || uri).trim();
      if (!id) {
        return null;
      }
      return {
        id,
        scheme: url.protocol.replace(':', ''),
        host: url.host,
        path: url.pathname,
        fragment: url.hash.replace('#', ''),
        query,
      };
    } catch {
      return null;
    }
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
      active.nextTimestampUs && Number.isFinite(active.nextTimestampUs) ? active.nextTimestampUs : nowUs;
    // If we fell behind (e.g., after a pause or reconnect), jump forward to avoid sending stale chunks.
    if (tsUs < nowUs) {
      tsUs = nowUs;
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
    // Use host uptime to align with snapclient steady clock (CLOCK_BOOTTIME).
    return Math.trunc(os.uptime() * 1_000_000);
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
        this.sendSettings(client, output, 0, true);
        pushed += 1;
      }
    }
    this.log.debug('snapcast pushed settings to clients', { streamId, count: pushed });
  }

  private sendSettings(
    client: SnapcastClient,
    output: AudioOutputSettings,
    refersTo: number,
    includeHeader: boolean,
  ): void {
    const config = this.getClientConfig(client.clientId ?? '');
    const group = this.findGroupByClientId(client.clientId ?? '');
    const muted = config.volume.muted || (group?.muted ?? false);
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
      latency: Number.isFinite(config.latency) ? config.latency : 0,
      volume: config.volume.percent,
      muted,
    });
    client.socket.send(settings);

    if (includeHeader) {
      const wavHeader = this.buildPcmCodecHeader(output.sampleRate, output.channels, output.pcmBitDepth);
      client.socket.send(wavHeader);
    }
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
      active.nextTimestampUs = 0;
      this.log.debug('snapcast stream drained (no clients)', { streamId });
    }
  }

  private handleRpcMessage(socket: WebSocket, raw: RawData): void {
    let payload: any;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      socket.send(
        JSON.stringify({
          id: null,
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error' },
        }),
      );
      return;
    }
    if (!payload || typeof payload !== 'object') return;
    const requests = Array.isArray(payload) ? payload : [payload];
    const responses: any[] = [];
    for (const request of requests) {
      const response = this.handleRpcRequest(request);
      if (response) {
        responses.push(response);
      }
    }
    if (responses.length > 0) {
      socket.send(JSON.stringify(Array.isArray(payload) ? responses : responses[0]));
    }
  }

  private handleRpcRequest(request: any): any | null {
    if (!request || typeof request !== 'object' || typeof request.method !== 'string') {
      if (request?.id === undefined) return null;
      return {
        id: request.id ?? null,
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid request' },
      };
    }
    const id = request.id ?? null;
    const method = request.method;
    const params = request.params ?? {};
    const reply = (result: any) => ({ id, jsonrpc: '2.0', result });
    const error = (code: number, message: string) => ({ id, jsonrpc: '2.0', error: { code, message } });

    switch (method) {
      case 'Server.GetRPCVersion':
        return reply({ major: 2, minor: 0, patch: 0 });
      case 'Server.GetStatus': {
        const status = this.buildStatus();
        return reply({ server: status });
      }
      case 'Client.GetStatus': {
        const clientId = typeof params.id === 'string' ? params.id : '';
        const client = this.findClientById(clientId);
        if (client) {
          return reply({ client: this.buildClientStatus(client, client.socket.readyState === WebSocket.OPEN) });
        }
        if (!clientId || !this.clientConfigs.has(clientId)) {
          return error(-32602, 'Invalid params');
        }
        return reply({ client: this.buildClientStatusFromConfig(clientId, false) });
      }
      case 'Client.SetVolume': {
        const clientId = typeof params.id === 'string' ? params.id : '';
        const volume = params.volume;
        if (!clientId || !volume || typeof volume !== 'object') {
          return error(-32602, 'Invalid params');
        }
        const muted = typeof volume.muted === 'boolean' ? volume.muted : false;
        const percent = Number(volume.percent);
        if (!Number.isFinite(percent)) {
          return error(-32602, 'Value for volume must be an int');
        }
        const clamped = Math.min(100, Math.max(0, Math.round(percent)));
        this.setClientVolume(clientId, { muted, percent: clamped });
        const client = this.findClientById(clientId);
        if (client && client.socket.readyState === WebSocket.OPEN) {
          const output =
            this.streams.get(client.streamId)?.output ??
            this.streams.values().next().value?.output ??
            audioOutputSettings;
          this.sendSettings(client, output, 0, false);
        }
        this.sendClientNotification('Client.OnVolumeChanged', { id: clientId, volume: { muted, percent: clamped } });
        this.sendServerUpdate();
        return reply({ volume: { muted, percent: clamped } });
      }
      case 'Client.SetLatency': {
        const clientId = typeof params.id === 'string' ? params.id : '';
        const latency = Number(params.latency);
        if (!clientId || !Number.isFinite(latency)) {
          return error(-32602, 'Invalid params');
        }
        const clamped = Math.max(0, Math.round(latency));
        this.ensureClientConfig(clientId).latency = clamped;
        const client = this.findClientById(clientId);
        if (client && client.socket.readyState === WebSocket.OPEN) {
          const output =
            this.streams.get(client.streamId)?.output ??
            this.streams.values().next().value?.output ??
            audioOutputSettings;
          this.sendSettings(client, output, 0, false);
        }
        this.sendClientNotification('Client.OnLatencyChanged', { id: clientId, latency: clamped });
        this.sendServerUpdate();
        return reply({ latency: clamped });
      }
      case 'Client.SetName': {
        const clientId = typeof params.id === 'string' ? params.id : '';
        const name = typeof params.name === 'string' ? params.name : '';
        if (!clientId) {
          return error(-32602, 'Invalid params');
        }
        this.ensureClientConfig(clientId).name = name;
        this.sendClientNotification('Client.OnNameChanged', { id: clientId, name });
        this.sendServerUpdate();
        return reply({ name });
      }
      case 'Group.GetStatus': {
        const groupId = typeof params.id === 'string' ? params.id : '';
        const group = this.groupConfigs.get(groupId);
        if (!group) {
          return error(-32602, 'Invalid params');
        }
        return reply({ group: this.buildGroupStatusFromGroup(group) });
      }
      case 'Group.SetMute': {
        const groupId = typeof params.id === 'string' ? params.id : '';
        const mute = params.mute;
        if (!groupId || typeof mute !== 'boolean') {
          return error(-32602, 'Invalid params');
        }
        const group = this.groupConfigs.get(groupId);
        if (!group) {
          return error(-32602, 'Group not found');
        }
        group.muted = mute;
        const active = this.streams.get(group.streamId);
        if (active) {
          for (const clientId of group.clientIds) {
            const client = this.findClientById(clientId);
            if (client && client.socket.readyState === WebSocket.OPEN) {
              this.sendSettings(client, active.output, 0, false);
            }
          }
        }
        this.sendClientNotification('Group.OnMute', { id: groupId, mute });
        this.sendServerUpdate();
        return reply({ mute });
      }
      case 'Group.SetStream': {
        const groupId = typeof params.id === 'string' ? params.id : '';
        const streamId = typeof params.stream_id === 'string' ? params.stream_id : '';
        if (!groupId || !streamId) {
          return error(-32602, 'Invalid params');
        }
        const group = this.groupConfigs.get(groupId);
        if (!group) {
          return error(-32602, 'Group not found');
        }
        group.streamId = streamId;
        for (const clientId of group.clientIds) {
          this.setClientStream(clientId, streamId);
        }
        this.sendClientNotification('Group.OnStreamChanged', { id: groupId, stream_id: streamId });
        this.sendServerUpdate();
        return reply({ stream_id: streamId });
      }
      case 'Group.SetClients': {
        const groupId = typeof params.id === 'string' ? params.id : '';
        const clients = Array.isArray(params.clients)
          ? params.clients.filter((c: unknown) => typeof c === 'string')
          : null;
        if (!groupId || !clients) {
          return error(-32602, 'Invalid params');
        }
        const group = this.groupConfigs.get(groupId);
        if (!group) {
          return error(-32602, 'Group not found');
        }
        const previousClients = new Set<string>(group.clientIds);
        const requestedClients = new Set<string>(clients);

        // Move removed clients into new standalone groups that keep the same stream.
        for (const clientId of previousClients) {
          if (requestedClients.has(clientId)) {
            continue;
          }
          group.clientIds.delete(clientId);
          const newGroupId = randomUUID();
          const newGroup = this.getOrCreateGroup(newGroupId, group.streamId);
          newGroup.clientIds.add(clientId);
          this.clientToGroup.set(clientId, newGroupId);
        }

        // Move requested clients into the target group.
        for (const clientId of requestedClients) {
          const currentGroup = this.findGroupByClientId(clientId);
          if (currentGroup && currentGroup.id !== group.id) {
            currentGroup.clientIds.delete(clientId);
            if (currentGroup.clientIds.size === 0) {
              this.groupConfigs.delete(currentGroup.id);
            }
          }
          group.clientIds.add(clientId);
          this.clientToGroup.set(clientId, group.id);
          this.setClientStream(clientId, group.streamId);
        }

        if (group.clientIds.size === 0) {
          this.groupConfigs.delete(group.id);
        }
        const status = this.buildStatus();
        this.sendServerUpdate();
        return reply({ server: status });
      }
      case 'Group.SetName': {
        const groupId = typeof params.id === 'string' ? params.id : '';
        const name = typeof params.name === 'string' ? params.name : '';
        if (!groupId) {
          return error(-32602, 'Invalid params');
        }
        const group = this.groupConfigs.get(groupId);
        if (!group) {
          return error(-32602, 'Group not found');
        }
        group.name = name;
        this.sendClientNotification('Group.OnNameChanged', { id: groupId, name });
        this.sendServerUpdate();
        return reply({ name });
      }
      case 'Server.DeleteClient': {
        const clientId = typeof params.id === 'string' ? params.id : '';
        const client = this.findClientById(clientId);
        if (!clientId) {
          return error(-32602, 'Invalid params');
        }
        if (!client && !this.clientConfigs.has(clientId)) {
          return error(-32602, 'Invalid params');
        }
        if (client) {
          try {
            client.socket.close();
          } catch {
            /* ignore */
          }
          this.clients.delete(client);
          this.removeClientFromGroup(clientId);
        }
        this.clientConfigs.delete(clientId);
        try {
          for (const group of this.groupConfigs.values()) {
            group.clientIds.delete(clientId);
          }
        } catch {
          /* ignore */
        }
        const status = this.buildStatus();
        this.sendServerUpdate();
        return reply({ server: status });
      }
      case 'Stream.Control': {
        const streamId =
          typeof params.id === 'string' ? params.id : typeof params.stream_id === 'string' ? params.stream_id : '';
        const command = typeof params.command === 'string' ? params.command : '';
        const commandParams = params && typeof params.params === 'object' ? params.params : {};
        if (!streamId || !command) {
          return error(-32602, "Parameter 'commmand' is missing");
        }
        const stream = this.streams.get(streamId);
        if (!stream) {
          return error(-32603, 'Stream not found');
        }
        const zoneId = stream.zoneId;
        switch (command) {
          case 'play':
            zoneManager.handleCommand(zoneId, 'play');
            return reply('ok');
          case 'pause':
            zoneManager.handleCommand(zoneId, 'pause');
            return reply('ok');
          case 'playPause': {
            const session = audioManager.getSession(zoneId);
            if (session?.state === 'playing') {
              zoneManager.handleCommand(zoneId, 'pause');
            } else {
              zoneManager.handleCommand(zoneId, 'play');
            }
            return reply('ok');
          }
          case 'stop':
            zoneManager.handleCommand(zoneId, 'stop');
            return reply('ok');
          case 'next':
            zoneManager.handleCommand(zoneId, 'queueplus');
            return reply('ok');
          case 'previous':
            zoneManager.handleCommand(zoneId, 'queueminus');
            return reply('ok');
          case 'setPosition': {
            const position = Number(commandParams.position ?? params.position ?? params.param);
            if (!Number.isFinite(position)) {
              return error(-32602, "setPosition requires parameter 'position'");
            }
            zoneManager.handleCommand(zoneId, 'position', String(position));
            return reply('ok');
          }
          case 'seek': {
            const offset = Number(commandParams.offset ?? params.offset ?? params.param);
            if (!Number.isFinite(offset)) {
              return error(-32602, "seek requires parameter 'offset'");
            }
            const session = audioManager.getSession(zoneId);
            const target = (session?.elapsed ?? 0) + offset;
            zoneManager.handleCommand(zoneId, 'position', String(target));
            return reply('ok');
          }
          default:
            return error(-32602, `Command '${command}' not supported`);
        }
      }
      case 'Stream.SetProperty': {
        const streamId = typeof params.id === 'string' ? params.id : '';
        const property = typeof params.property === 'string' ? params.property : '';
        if (!streamId || !property) {
          return error(-32602, "Parameter 'property' is missing");
        }
        const stream = this.streams.get(streamId);
        if (!stream) {
          return error(-32603, 'Stream not found');
        }
        const zoneId = stream.zoneId;
        if (property === 'volume') {
          const value = Number(params.value);
          if (!Number.isFinite(value)) {
            return error(-32602, 'Value for volume must be an int');
          }
          zoneManager.handleCommand(zoneId, 'volume_set', String(value));
          return reply('ok');
        }
        if (property === 'mute') {
          if (typeof params.value !== 'boolean') {
            return error(-32602, 'Value for mute must be bool');
          }
          const mute = params.value;
          if (mute) {
            const snapshot = zoneManager.getZoneState(zoneId)?.volume ?? 0;
            this.streamMuteSnapshots.set(streamId, snapshot);
            zoneManager.handleCommand(zoneId, 'volume_set', '0');
          } else {
            const restore = this.streamMuteSnapshots.get(streamId);
            if (typeof restore === 'number') {
              zoneManager.handleCommand(zoneId, 'volume_set', String(restore));
              this.streamMuteSnapshots.delete(streamId);
            }
          }
          return reply('ok');
        }
        if (property === 'shuffle') {
          if (typeof params.value !== 'boolean') {
            return error(-32602, 'Value for shuffle must be bool');
          }
          zoneManager.setShuffle(zoneId, params.value);
          return reply('ok');
        }
        if (property === 'loopStatus') {
          if (typeof params.value !== 'string') {
            return error(-32602, "Value for loopStatus must be one of 'none', 'track', 'playlist'");
          }
          if (params.value === 'none') {
            zoneManager.setRepeatMode(zoneId, 'off');
            return reply('ok');
          }
          if (params.value === 'track') {
            zoneManager.setRepeatMode(zoneId, 'one');
            return reply('ok');
          }
          if (params.value === 'playlist') {
            zoneManager.setRepeatMode(zoneId, 'all');
            return reply('ok');
          }
          return error(-32602, "Value for loopStatus must be one of 'none', 'track', 'playlist'");
        }
        if (property === 'rate') {
          if (!Number.isFinite(Number(params.value))) {
            return error(-32602, 'Value for rate must be float');
          }
          return error(-32603, 'Stream property rate not supported');
        }
        return error(-32602, `Property '${property}' not supported`);
      }
      case 'Stream.AddStream':
        return this.handleStreamAdd(params, reply, error);
      case 'Stream.RemoveStream': {
        const streamId = typeof params.id === 'string' ? params.id : '';
        if (!streamId) {
          return error(-32602, 'Invalid params');
        }
        if (!this.streams.has(streamId) && !this.rpcStreams.has(streamId)) {
          return error(-32603, 'Stream not found');
        }
        this.rpcStreams.delete(streamId);
        this.clearStream(streamId);
        for (const [groupId, group] of this.groupConfigs.entries()) {
          if (groupId === streamId || group.streamId === streamId) {
            this.groupConfigs.delete(groupId);
          }
        }
        this.sendServerUpdate();
        return reply({ stream_id: streamId });
      }
      default:
        if (request.id === undefined) return null;
        return error(-32601, 'Method not found');
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
    const streams = this.buildStreamStatusList();
    const groups = this.buildGroupStatusList();
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
    const zoneState = zoneManager.getZoneState(active.zoneId);
    const hasSession = Boolean(session);
    const duration = meta?.duration ?? session?.duration ?? undefined;
    const metadata = meta
      ? {
          title: meta.title ?? undefined,
          artist: meta.artist ? [meta.artist] : undefined,
          album: meta.album ?? undefined,
          artUrl: meta.coverurl ?? session?.stream?.coverUrl,
          duration,
        }
      : undefined;
    const playbackStatus =
      session?.state === 'playing' ? 'playing' : session?.state === 'paused' ? 'paused' : 'stopped';
    const position = session?.elapsed ?? undefined;
    const loopStatus =
      zoneState?.plrepeat === 3 ? 'track' : zoneState?.plrepeat === 1 ? 'playlist' : 'none';
    return {
      id: active.streamId,
      status: playbackStatus === 'playing' ? 'playing' : 'idle',
      properties: {
        canControl: hasSession,
        canGoNext: hasSession,
        canGoPrevious: hasSession,
        canPause: hasSession,
        canPlay: hasSession,
        canSeek: hasSession && typeof duration === 'number' && duration > 0,
        loopStatus,
        shuffle: zoneState?.plshuffle === 1,
        volume: zoneState?.volume ?? 100,
        playbackStatus,
        position,
        metadata,
      },
      uri: {
        raw: `ws://${this.pickLocalAddress()}:7090/snapcast/${active.streamId}`,
        scheme: 'ws',
        host: this.pickLocalAddress(),
        path: `/snapcast/${active.streamId}`,
        fragment: '',
        query: {},
      },
    };
  }

  private buildStreamStatusList(): any[] {
    const activeStreams = Array.from(this.streams.values()).map((stream) =>
      this.buildStreamStatus(stream),
    );
    const rpcOnly = Array.from(this.rpcStreams.values())
      .filter((stream) => !this.streams.has(stream.id))
      .map((stream) => this.buildRpcStreamStatus(stream));
    return [...activeStreams, ...rpcOnly];
  }

  private buildRpcStreamStatus(stream: RpcStream): any {
    const uri = this.parseStreamUri(stream.uri);
    return {
      id: stream.id,
      status: 'idle',
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
        playbackStatus: 'stopped',
        position: undefined,
        metadata: undefined,
      },
      uri: uri
        ? {
            raw: stream.uri,
            scheme: uri.scheme,
            host: uri.host,
            path: uri.path,
            fragment: uri.fragment,
            query: uri.query,
          }
        : {
            raw: stream.uri,
            scheme: '',
            host: '',
            path: '',
            fragment: '',
            query: {},
          },
    };
  }

  private buildGroupStatus(active: ActiveStream): any {
    const group = this.findGroupByStreamId(active.streamId);
    if (group) {
      return this.buildGroupStatusFromGroup(group);
    }
    return null;
  }

  private buildGroupStatusList(): any[] {
    return Array.from(this.groupConfigs.values())
      .map((group) => this.buildGroupStatusFromGroup(group))
      .filter(Boolean);
  }

  private buildGroupStatusFromGroup(group: SnapcastGroupState): any {
    const clients = Array.from(group.clientIds).map((id) => {
      const live = this.findClientById(id);
      if (live) {
        return this.buildClientStatus(live, live.socket.readyState === WebSocket.OPEN);
      }
      return this.buildClientStatusFromConfig(id, false);
    });
    return {
      id: group.id,
      name: group.name,
      muted: group.muted,
      stream_id: group.streamId,
      clients,
    };
  }

  private buildClientStatus(client: SnapcastClient, connected: boolean): any {
    const clientId = client.clientId ?? 'unknown';
    const config = this.getClientConfig(clientId);
    return {
      id: clientId,
      connected,
      config: {
        instance: config.instance,
        latency: config.latency,
        name: config.name,
        volume: { muted: config.volume.muted, percent: config.volume.percent },
      },
      host: {
        arch: config.host.arch || 'web',
        ip: config.host.ip,
        mac: config.host.mac,
        name: config.host.name || config.name || clientId,
        os: config.host.os,
      },
      snapclient: {
        name: config.snapclient.name || 'snapclient',
        protocolVersion: config.snapclient.protocolVersion || 2,
        version: config.snapclient.version || '0.0.0',
      },
      lastSeen: { sec: Math.floor(Date.now() / 1000), usec: 0 },
    };
  }

  private buildClientStatusFromConfig(clientId: string, connected: boolean): any {
    const config = this.getClientConfig(clientId);
    return {
      id: clientId,
      connected,
      config: {
        instance: config.instance,
        latency: config.latency,
        name: config.name,
        volume: { muted: config.volume.muted, percent: config.volume.percent },
      },
      host: {
        arch: config.host.arch || 'web',
        ip: config.host.ip,
        mac: config.host.mac,
        name: config.host.name || config.name || clientId,
        os: config.host.os,
      },
      snapclient: {
        name: config.snapclient.name || 'snapclient',
        protocolVersion: config.snapclient.protocolVersion || 2,
        version: config.snapclient.version || '0.0.0',
      },
      lastSeen: { sec: Math.floor(Date.now() / 1000), usec: 0 },
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

  private ensureClientConfig(clientId: string, instance?: number): SnapcastClientConfig {
    const parsedInstance = this.parseInstance(clientId, instance);
    const existing = this.clientConfigs.get(clientId);
    if (existing) {
      existing.instance = parsedInstance;
      return existing;
    }
    const config: SnapcastClientConfig = {
      instance: parsedInstance,
      latency: 0,
      name: '',
      volume: { muted: false, percent: 100 },
      host: {
        arch: '',
        ip: '',
        mac: '',
        name: '',
        os: '',
      },
      snapclient: {
        name: 'snapclient',
        protocolVersion: 2,
        version: '0.0.0',
      },
    };
    this.clientConfigs.set(clientId, config);
    return config;
  }

  private getClientConfig(clientId: string): SnapcastClientConfig {
    return this.ensureClientConfig(clientId);
  }

  private getClientVolume(clientId: string | null): SnapcastVolume {
    if (!clientId) {
      return { muted: false, percent: 100 };
    }
    return this.ensureClientConfig(clientId).volume;
  }

  private setClientVolume(clientId: string, volume: SnapcastVolume): void {
    const config = this.ensureClientConfig(clientId);
    config.volume = volume;
  }

  private parseInstance(clientId: string, instance?: number): number {
    if (typeof instance === 'number' && instance > 0) {
      return Math.floor(instance);
    }
    const match = /#(\d+)$/.exec(clientId);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return 1;
  }

  private findClientById(clientId: string): SnapcastClient | null {
    for (const client of this.clients) {
      if (client.clientId === clientId) {
        return client;
      }
    }
    return null;
  }

  private updateClientStream(client: SnapcastClient, streamId: string): void {
    if (client.streamId === streamId) {
      return;
    }
    const previous = client.streamId;
    client.streamId = streamId;
    this.updateFlowControl(previous);
    this.updateFlowControl(streamId);
  }

  private ensureGroupForClient(clientId: string, streamId: string): void {
    const existing = this.findGroupByClientId(clientId);
    if (existing) {
      existing.clientIds.add(clientId);
      return;
    }
    const groupId = randomUUID();
    const group = this.getOrCreateGroup(groupId, streamId);
    group.clientIds.add(clientId);
    this.clientToGroup.set(clientId, groupId);
  }

  private removeClientFromGroup(clientId: string): void {
    const group = this.findGroupByClientId(clientId);
    if (!group) {
      return;
    }
    group.clientIds.delete(clientId);
    this.clientToGroup.delete(clientId);
    if (group.clientIds.size === 0) {
      this.groupConfigs.delete(group.id);
    }
  }

  private findGroupByStreamId(streamId: string): SnapcastGroupState | null {
    for (const group of this.groupConfigs.values()) {
      if (group.streamId === streamId) {
        return group;
      }
    }
    return null;
  }

  private findGroupByClientId(clientId: string): SnapcastGroupState | null {
    if (!clientId) {
      return null;
    }
    const groupId = this.clientToGroup.get(clientId);
    if (groupId) {
      const group = this.groupConfigs.get(groupId);
      if (group) {
        return group;
      }
    }
    for (const group of this.groupConfigs.values()) {
      if (group.clientIds.has(clientId)) {
        this.clientToGroup.set(clientId, group.id);
        return group;
      }
    }
    return null;
  }

  private getOrCreateGroup(id: string, streamId: string): SnapcastGroupState {
    const existing = this.groupConfigs.get(id);
    if (existing) {
      return existing;
    }
    const group: SnapcastGroupState = {
      id,
      name: '',
      muted: false,
      streamId,
      clientIds: new Set(),
    };
    this.groupConfigs.set(id, group);
    return group;
  }

  private sendClientNotification(method: string, params: Record<string, unknown>): void {
    if (this.rpcClients.size === 0) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    for (const client of Array.from(this.rpcClients)) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  private sendServerUpdate(): void {
    if (this.rpcClients.size === 0) return;
    const status = this.buildStatus();
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method: 'Server.OnUpdate',
      params: { server: status },
    });
    for (const client of Array.from(this.rpcClients)) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }
}

export const snapcastCore = new SnapcastCore();
