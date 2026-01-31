import { PassThrough } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import { AirplaySender } from '@/adapters/outputs/airplay/airplaySender';

type ClientId = string;

interface FlowClient {
  id: ClientId;
  sender: AirplaySender;
  volume: number;
  targetUrl: string | null;
  stream: PassThrough | null;
  ready: boolean;
  feed: PassThrough | null;
  buffer: ClientBuffer | null;
}

/**
 * Very small flow-session layer to prepare for multiple AirPlay clients.
 * Currently used for a single target, but keeps the writer abstraction in place.
 */
export class AirplayFlowSession {
  private readonly log = createLogger('Output', 'AirPlayFlow');
  private readonly clients = new Map<ClientId, FlowClient>();
  private sharedStream: PassThrough | null = null;
  private readonly backlog: Buffer[] = [];
  private backlogBytes = 0;
  private readonly maxBacklogBytes = 1024 * 512; // 512KB rolling buffer for late joiners
  private readonly chunkQueue: Buffer[] = [];
  private chunkQueueBytes = 0;
  private chunkTimer: NodeJS.Timeout | null = null;
  private readonly chunkDurationMs = 80;
  private readonly maxChunkQueueSeconds = 2;
  private chunkSizeBytes = 44100 * 2 * 2;
  private maxChunkQueueBytes = 44100 * 2 * 2;
  private preloadBytes = 44100 * 2 * 2;
  private preloadComplete = false;
  private lastTrimLogAt = 0;
  private sourceAttached = false;
  private streamedBytes = 0;
  private bytesPerSecond = 44100 * 2 * 2;
  private pendingEndTimer: NodeJS.Timeout | null = null;
  private pendingEndStream: PassThrough | null = null;
  private lastMetricsLogAt = 0;
  private readonly metricsLogIntervalMs = 2000;
  private paused = false;

  constructor(private readonly zoneId: number) {}

  public async startClient(
    clientId: ClientId,
    sender: AirplaySender,
    inputUrl: string | null,
    stream: PassThrough | null,
    volume: number,
    ntpStart?: bigint | null,
    primeBacklog = true,
  ): Promise<void> {
    this.paused = false;
    this.log.debug('airplay flow start client', {
      zoneId: this.zoneId,
      clientId,
      inputUrl,
      hasStream: Boolean(stream),
      senderRunning: sender.isRunning(),
      primeBacklog,
      hasNtpStart: ntpStart !== undefined && ntpStart !== null,
    });
    await this.ensureSharedStream(stream);
    const hasSharedSource = Boolean(stream ?? this.sharedStream);

    const existing = this.clients.get(clientId);
    if (existing && existing.sender === sender) {
      existing.targetUrl = inputUrl;
      existing.stream = stream;
      existing.ready = false;
      // If we are still driving a shared PCM stream, do not restart the sender.
      if (hasSharedSource && sender.isRunning()) {
        if (existing.buffer && primeBacklog) {
          existing.buffer.reset();
          this.primeClient(existing);
        }
        existing.volume = volume;
        this.ensureChunker();
        return;
      }
      if (hasSharedSource && !existing.feed) {
        existing.feed = new PassThrough({ highWaterMark: 1024 * 2048 });
        existing.buffer = new ClientBuffer(
          (chunk) => {
            if (!existing.feed!.writableEnded && !existing.feed!.destroyed) {
              existing.feed!.write(chunk);
            }
          },
          (err) => {
            this.log.warn('airplay flow feed write error', {
              zoneId: this.zoneId,
              message: err instanceof Error ? err.message : String(err),
            });
          },
        );
        existing.feed.once('close', () => this.clients.delete(clientId));
        existing.feed.once('error', (err) => {
          this.log.warn('airplay flow feed error', {
            zoneId: this.zoneId,
            message: err instanceof Error ? err.message : String(err),
          });
        });
      }
      if (existing.buffer && primeBacklog) {
        existing.buffer.reset();
        this.primeClient(existing);
      }
      await existing.sender.start(
        inputUrl,
        volume,
        hasSharedSource ? existing.feed : null,
        ntpStart ?? undefined,
      );
      existing.volume = volume;
      return;
    }

    const feed = hasSharedSource ? new PassThrough({ highWaterMark: 1024 * 2048 }) : null;
    const buffer =
      feed &&
      new ClientBuffer(
        (chunk) => {
          if (!feed.writableEnded && !feed.destroyed) {
            feed.write(chunk);
          }
        },
        (err) => {
          this.log.warn('airplay flow feed write error', {
            zoneId: this.zoneId,
            message: err instanceof Error ? err.message : String(err),
          });
        },
      );

    const client: FlowClient = {
      id: clientId,
      sender,
      volume,
      targetUrl: inputUrl,
      stream,
      ready: false,
      feed,
      buffer: buffer || null,
    };

    if (buffer && primeBacklog) {
      // Prebuffer with recent data so late joiners don't start from silence.
      this.primeClient(client);
      feed!.once('close', () => this.clients.delete(clientId));
      feed!.once('error', (err) => {
        this.log.warn('airplay flow feed error', {
          zoneId: this.zoneId,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }

    this.clients.set(clientId, client);
    await sender.start(inputUrl, volume, hasSharedSource ? feed : null, ntpStart ?? undefined);
    this.ensureChunker();
    this.log.info('airplay client started', {
      zoneId: this.zoneId,
      clientId,
      targetUrl: inputUrl ?? undefined,
      hasSharedSource,
    });
  }

  public async setVolume(clientId: ClientId, volume: number): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;
    client.volume = volume;
    await client.sender.setVolume(volume);
  }

  public async stopAll(): Promise<void> {
    this.log.debug('airplay flow stop all', {
      zoneId: this.zoneId,
      clients: this.clients.size,
    });
    await Promise.all(
      Array.from(this.clients.values()).map((c) => this.stopClientSafe(c.id)),
    );
    this.clients.clear();
    this.stopChunker();
    this.detachSharedStream();
    if (this.sharedStream && !this.sharedStream.destroyed) {
      try {
        this.sharedStream.destroy();
      } catch {
        /* ignore */
      }
    }
    this.sharedStream = null;
    this.backlog.length = 0;
    this.backlogBytes = 0;
    this.streamedBytes = 0;
    this.chunkQueue.length = 0;
    this.chunkQueueBytes = 0;
    this.preloadComplete = false;
    this.paused = false;
  }

  public async pauseClients(): Promise<void> {
    if (this.paused) {
      return;
    }
    this.paused = true;
    this.stopChunker();
    this.resetBuffers('pause');
    await Promise.all(Array.from(this.clients.values()).map((c) => this.stopClientSafe(c.id)));
  }

  public pause(): void {
    if (this.paused) {
      return;
    }
    this.paused = true;
    this.stopChunker();
    this.resetBuffers('pause');
  }

  public resume(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    this.resetBuffers('resume');
    this.ensureChunker();
  }

  public getClient(clientId: ClientId): FlowClient | undefined {
    return this.clients.get(clientId);
  }

  public async setSharedStream(stream: PassThrough | null): Promise<void> {
    if (!stream) return;
    await this.ensureSharedStream(stream);
  }

  public markReady(clientId: ClientId): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.ready = true;
      client.buffer?.ready();
      client.sender.releaseBuffers();
    }
  }

  public resetBuffers(reason?: string): void {
    if (reason) {
      this.log.debug('airplay flow buffers reset', { zoneId: this.zoneId, reason });
    }
    this.backlog.length = 0;
    this.backlogBytes = 0;
    this.streamedBytes = 0;
    this.chunkQueue.length = 0;
    this.chunkQueueBytes = 0;
    this.preloadComplete = false;
    for (const client of this.clients.values()) {
      client.buffer?.reset();
      if (client.ready) {
        client.buffer?.ready();
      }
    }
  }

  public getSecondsStreamed(): number {
    if (!this.streamedBytes) return 0;
    return this.streamedBytes / this.bytesPerSecond;
  }

  public getPreloadSeconds(): number {
    if (!this.bytesPerSecond) return 0;
    return this.preloadBytes / this.bytesPerSecond;
  }

  public setOutputFormat(sampleRate: number, channels: number, bitDepth: number): void {
    if (!Number.isFinite(sampleRate) || !Number.isFinite(channels) || !Number.isFinite(bitDepth)) {
      return;
    }
    if (sampleRate <= 0 || channels <= 0 || bitDepth <= 0) {
      return;
    }
    const bytesPerSample = bitDepth / 8;
    if (!Number.isFinite(bytesPerSample) || bytesPerSample <= 0) {
      return;
    }
    this.bytesPerSecond = sampleRate * channels * bytesPerSample;
    this.chunkSizeBytes = Math.max(1, Math.round((this.bytesPerSecond * this.chunkDurationMs) / 1000));
    this.maxChunkQueueBytes = Math.max(1, Math.round(this.bytesPerSecond * this.maxChunkQueueSeconds));
    this.preloadBytes = Math.max(1, Math.round(this.bytesPerSecond * 0.25));
  }

  public async stopClientSafe(clientId: ClientId): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.log.debug('airplay flow stopping client', { zoneId: this.zoneId, clientId });
    try {
      await client.sender.stop();
    } catch (err) {
      this.log.warn('airplay flow stop failed', {
        zoneId: this.zoneId,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (client.feed) {
        try {
          client.feed.destroy();
        } catch {
          /* ignore */
        }
      }
      this.clients.delete(clientId);
      this.log.info('airplay client stopped', { zoneId: this.zoneId, clientId });
      if (this.clients.size === 0) {
        this.stopChunker();
      }
    }
  }

  private async ensureSharedStream(stream: PassThrough | null): Promise<void> {
    if (stream && stream !== this.sharedStream) {
      this.attachSharedStream(stream);
      return;
    }
    if (!this.sharedStream && stream) {
      this.attachSharedStream(stream);
    }
  }

  private attachSharedStream(stream: PassThrough): void {
    if (this.pendingEndTimer) {
      clearTimeout(this.pendingEndTimer);
      this.pendingEndTimer = null;
      this.pendingEndStream = null;
    }
    const isSwap = this.sourceAttached && this.sharedStream && this.sharedStream !== stream;
    if (isSwap && this.sharedStream) {
      this.detachSharedStream();
      this.resetSharedState();
    }
    this.sharedStream = stream;
    const onData = (chunk: Buffer) => this.handleSourceChunk(chunk);
    const onEnd = () => this.handleSourceEnd(stream);
    const onError = (err: Error) => {
      this.log.warn('airplay shared stream error', {
        zoneId: this.zoneId,
        message: err.message,
      });
      this.handleSourceEnd(stream);
    };
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('close', onEnd);
    stream.once('error', onError);
    // Track listeners to remove later.
    (stream as any)._lox_onData = onData;
    (stream as any)._lox_onEnd = onEnd;
    (stream as any)._lox_onError = onError;
    this.sourceAttached = true;
  }

  private detachSharedStream(): void {
    if (!this.sharedStream) {
      return;
    }
    const stream: any = this.sharedStream;
    if (stream._lox_onData) this.sharedStream.off('data', stream._lox_onData);
    if (stream._lox_onEnd) {
      this.sharedStream.off('end', stream._lox_onEnd);
      this.sharedStream.off('close', stream._lox_onEnd);
    }
    if (stream._lox_onError) this.sharedStream.off('error', stream._lox_onError);
    delete stream._lox_onData;
    delete stream._lox_onEnd;
    delete stream._lox_onError;
    this.sourceAttached = false;
  }

  private handleSourceChunk(chunk: Buffer): void {
    if (!chunk?.length) {
      return;
    }
    if (this.paused) {
      return;
    }
    // Maintain a rolling backlog for late joiners.
    if (this.backlogBytes < this.maxBacklogBytes) {
      this.backlog.push(chunk);
      this.backlogBytes += chunk.length;
    }
    while (this.backlogBytes > this.maxBacklogBytes && this.backlog.length > 0) {
      const removed = this.backlog.shift();
      if (removed) this.backlogBytes -= removed.length;
    }
    this.enqueueChunk(chunk);
    this.maybeLogMetrics();
  }

  private handleSourceEnd(stream?: PassThrough): void {
    if (stream && stream !== this.sharedStream) {
      return;
    }
    if (this.pendingEndTimer) {
      return;
    }
    const endedStream = this.sharedStream;
    this.detachSharedStream();
    this.sharedStream = null;
    this.resetSharedState();
    this.pendingEndStream = endedStream;
    this.pendingEndTimer = setTimeout(() => {
      const pendingStream = this.pendingEndStream;
      this.pendingEndTimer = null;
      this.pendingEndStream = null;
      if (this.sharedStream || (pendingStream && pendingStream !== this.sharedStream)) {
        return;
      }
      this.finishSharedStream();
    }, 12000);
  }

  private resetSharedState(): void {
    this.backlog.length = 0;
    this.backlogBytes = 0;
    this.streamedBytes = 0;
    this.chunkQueue.length = 0;
    this.chunkQueueBytes = 0;
    this.preloadComplete = false;
    for (const client of this.clients.values()) {
      client.buffer?.reset();
      client.ready = false;
    }
  }

  private finishSharedStream(): void {
    this.log.debug('shared airplay stream ended', { zoneId: this.zoneId });
    this.detachSharedStream();
    this.sharedStream = null;
    this.backlog.length = 0;
    this.backlogBytes = 0;
    this.streamedBytes = 0;
    this.chunkQueue.length = 0;
    this.chunkQueueBytes = 0;
    this.preloadComplete = false;
    for (const client of this.clients.values()) {
      client.buffer?.flush();
      client.feed?.end();
    }
  }

  private primeClient(client: FlowClient): void {
    if (!this.backlog.length) {
      return;
    }
    for (const chunk of this.backlog) {
      client.buffer?.push(chunk);
    }
  }

  private enqueueChunk(chunk: Buffer): void {
    if (!chunk?.length) return;
    const maxBytes = this.maxChunkQueueBytes || Math.max(1, this.bytesPerSecond * this.maxChunkQueueSeconds);
    let droppedBytes = 0;
    while (this.chunkQueueBytes + chunk.length > maxBytes && this.chunkQueue.length > 0) {
      const removed = this.chunkQueue.shift();
      if (removed) {
        this.chunkQueueBytes -= removed.length;
        droppedBytes += removed.length;
      }
    }
    if (this.chunkQueueBytes + chunk.length > maxBytes) {
      const now = Date.now();
      if (now - this.lastTrimLogAt > this.metricsLogIntervalMs) {
        this.lastTrimLogAt = now;
        this.log.debug('airplay flow chunk queue drop', {
          zoneId: this.zoneId,
          maxBytes,
          queuedBytes: this.chunkQueueBytes,
          incomingBytes: chunk.length,
          droppedBytes,
        });
      }
      return;
    }
    if (droppedBytes > 0) {
      const now = Date.now();
      if (now - this.lastTrimLogAt > this.metricsLogIntervalMs) {
        this.lastTrimLogAt = now;
        this.log.debug('airplay flow chunk queue drop', {
          zoneId: this.zoneId,
          maxBytes,
          queuedBytes: this.chunkQueueBytes,
          incomingBytes: chunk.length,
          droppedBytes,
        });
      }
    }
    this.chunkQueue.push(chunk);
    this.chunkQueueBytes += chunk.length;
  }

  private ensureChunker(): void {
    if (this.chunkTimer || this.clients.size === 0) {
      return;
    }
    if (this.paused) {
      return;
    }
    this.chunkTimer = setTimeout(() => this.runChunker(), this.chunkDurationMs);
  }

  private stopChunker(): void {
    if (!this.chunkTimer) return;
    clearTimeout(this.chunkTimer);
    this.chunkTimer = null;
  }

  private runChunker(): void {
    this.chunkTimer = null;
    if (this.clients.size === 0) {
      return;
    }
    if (this.paused) {
      return;
    }
    if (!this.preloadComplete) {
      if (this.chunkQueueBytes >= this.preloadBytes) {
        this.preloadComplete = true;
        this.log.debug('airplay flow preload complete', {
          zoneId: this.zoneId,
          preloadBytes: this.preloadBytes,
        });
      } else {
        this.chunkTimer = setTimeout(() => this.runChunker(), this.chunkDurationMs);
        return;
      }
    }
    const drainCount =
      this.maxChunkQueueBytes > 0 && this.chunkQueueBytes > this.maxChunkQueueBytes * 0.75 ? 2 : 1;
    for (let i = 0; i < drainCount; i += 1) {
      const next = this.popChunk(this.chunkSizeBytes);
      if (!next) break;
      for (const client of this.clients.values()) {
        client.buffer?.push(next);
      }
      this.streamedBytes += next.length;
    }
    this.chunkTimer = setTimeout(() => this.runChunker(), this.chunkDurationMs);
  }

  private popChunk(targetBytes: number): Buffer | null {
    if (this.chunkQueueBytes < targetBytes || this.chunkQueue.length === 0) {
      return null;
    }
    let remaining = targetBytes;
    const parts: Buffer[] = [];
    while (remaining > 0 && this.chunkQueue.length > 0) {
      const head = this.chunkQueue[0];
      if (head.length <= remaining) {
        parts.push(head);
        remaining -= head.length;
        this.chunkQueue.shift();
        this.chunkQueueBytes -= head.length;
      } else {
        parts.push(head.subarray(0, remaining));
        this.chunkQueue[0] = head.subarray(remaining);
        this.chunkQueueBytes -= remaining;
        remaining = 0;
      }
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  private maybeLogMetrics(): void {
    const now = Date.now();
    if (now - this.lastMetricsLogAt < this.metricsLogIntervalMs) {
      return;
    }
    this.lastMetricsLogAt = now;
    let ready = 0;
    const clientStats = Array.from(this.clients.values()).map((client) => {
      if (client.ready) ready += 1;
      return {
        id: client.id,
        ready: client.ready,
        bufferBytes: client.buffer?.getBufferedBytes() ?? 0,
        feedBytes: (client.feed as any)?.readableLength ?? 0,
      };
    });
    this.log.spam('airplay flow metrics', {
      zoneId: this.zoneId,
      clients: this.clients.size,
      ready,
      backlogBytes: this.backlogBytes,
      chunkQueueBytes: this.chunkQueueBytes,
      preloadComplete: this.preloadComplete,
      streamedSeconds: Number(this.getSecondsStreamed().toFixed(2)),
      clientStats,
    });
  }
}

class ClientBuffer {
  private readonly queue: Buffer[] = [];
  private bytes = 0;
  private readyFlag = false;

  constructor(
    private readonly write: (chunk: Buffer) => void,
    private readonly onError: (err: unknown) => void,
    private readonly maxBytes = 1024 * 3072,
  ) {}

  public push(chunk: Buffer): void {
    if (this.readyFlag) {
      this.safeWrite(chunk);
      return;
    }
    this.queue.push(chunk);
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      // Drop oldest data if we exceed the max backlog for a single client.
      while (this.bytes > this.maxBytes && this.queue.length) {
        const removed = this.queue.shift();
        if (removed) this.bytes -= removed.length;
      }
    }
  }

  public ready(): void {
    if (this.readyFlag) return;
    this.readyFlag = true;
    this.flush();
  }

  public flush(): void {
    if (!this.queue.length) return;
    const chunks = this.queue.splice(0);
    this.bytes = 0;
    for (const chunk of chunks) {
      this.safeWrite(chunk);
    }
  }

  public reset(): void {
    this.queue.length = 0;
    this.bytes = 0;
    this.readyFlag = false;
  }

  public getBufferedBytes(): number {
    return this.bytes;
  }

  private safeWrite(chunk: Buffer): void {
    try {
      this.write(chunk);
    } catch (err) {
      this.onError(err);
    }
  }
}
