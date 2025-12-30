import { PassThrough } from 'node:stream';
import { createLogger } from '@/core/logging/logger';
import { AirplaySender } from '@/modules/audio/outputs/airplay/airplaySender';

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
  private readonly log = createLogger('Transport', 'AirPlayFlow');
  private readonly clients = new Map<ClientId, FlowClient>();
  private sharedStream: PassThrough | null = null;
  private readonly backlog: Buffer[] = [];
  private backlogBytes = 0;
  private readonly maxBacklogBytes = 1024 * 2048; // 2MB rolling buffer for late joiners
  private sourceAttached = false;
  private streamedBytes = 0;
  private bytesPerSecond = 44100 * 2 * 2;
  private pendingEndTimer: NodeJS.Timeout | null = null;
  private pendingEndStream: PassThrough | null = null;

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
        return;
      }
      if (hasSharedSource && !existing.feed) {
        existing.feed = new PassThrough({ highWaterMark: 1024 * 512 });
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

    const feed = hasSharedSource ? new PassThrough({ highWaterMark: 1024 * 512 }) : null;
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

  public getSecondsStreamed(): number {
    if (!this.streamedBytes) return 0;
    return this.streamedBytes / this.bytesPerSecond;
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
    this.streamedBytes += chunk.length;
    // Maintain a rolling backlog for late joiners.
    if (this.backlogBytes < this.maxBacklogBytes) {
      this.backlog.push(chunk);
      this.backlogBytes += chunk.length;
    }
    while (this.backlogBytes > this.maxBacklogBytes && this.backlog.length > 0) {
      const removed = this.backlog.shift();
      if (removed) this.backlogBytes -= removed.length;
    }
    for (const client of this.clients.values()) {
      client.buffer?.push(chunk);
    }
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
}

class ClientBuffer {
  private readonly queue: Buffer[] = [];
  private bytes = 0;
  private readyFlag = false;

  constructor(
    private readonly write: (chunk: Buffer) => void,
    private readonly onError: (err: unknown) => void,
    private readonly maxBytes = 1024 * 512,
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

  private safeWrite(chunk: Buffer): void {
    try {
      this.write(chunk);
    } catch (err) {
      this.onError(err);
    }
  }
}
