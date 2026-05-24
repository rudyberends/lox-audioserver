import { PassThrough } from 'node:stream';

/**
 * Upstream throttle hooks. Called when the fanout wants more or less data
 * from whatever feeds it (ffmpeg stdout, a librespot pipe, etc.). The upstream
 * decides whether a pause/resume actually takes effect — the fanout just
 * signals intent.
 */
export interface FanoutUpstream {
  pause(): void;
  resume(): void;
}

export interface FanoutLogger {
  debug(message: string, context?: Record<string, unknown>): void;
}

export interface AttachOptions {
  zoneId: number;
  profile: string;
  primeWithBuffer?: boolean;
  label?: string;
  /** Codec init bytes (e.g. FLAC STREAMINFO) prepended before the rolling buffer. */
  codecHeader?: Buffer | null;
  /** Chunks from the rolling buffer used to prime the subscriber. */
  primingChunks?: readonly Buffer[];
  /** PCM frame-rate info — when present, debug log includes a primedMs field. */
  pcmFrameRate?: { sampleRate: number; channels: number; bitDepth: number } | null;
  /** Reported in the attach-log for diagnostics. */
  sessionBufferedBytes: number;
}

/**
 * Fan-out of one audio source to many subscribers (HTTP clients, Cast adapters,
 * Squeezelite shims). Owns per-subscriber backpressure tracking and slow-client
 * eviction. The upstream's pause/resume callbacks are invoked whenever pressure
 * or subscriber-count changes; it is the upstream's job to combine those
 * signals with its own state.
 */
export class SubscriberFanout {
  private readonly subscribers = new Set<PassThrough>();
  private readonly subscriberLabels = new Map<PassThrough, string>();
  private subscriberCounter = 0;
  private readonly backpressureListeners = new Map<PassThrough, () => void>();
  private backpressureCount = 0;
  private dropCount = 0;
  private lastDropAt: number | null = null;

  constructor(
    private readonly upstream: FanoutUpstream,
    private readonly log: FanoutLogger,
    private readonly maxLagBytes: number,
  ) {}

  public get size(): number {
    return this.subscribers.size;
  }

  public get drops(): { count: number; lastAt: number | null } {
    return { count: this.dropCount, lastAt: this.lastDropAt };
  }

  public hasBackpressure(): boolean {
    return this.backpressureCount > 0;
  }

  public labels(): string[] {
    return Array.from(this.subscriberLabels.values());
  }

  public attach(options: AttachOptions): PassThrough {
    const stream = new PassThrough({ highWaterMark: 1024 * 512 });
    let primedBytes = 0;
    const primeWithBuffer = options.primeWithBuffer !== false;
    if (options.codecHeader && options.codecHeader.length) {
      stream.write(options.codecHeader);
      primedBytes += options.codecHeader.length;
    }
    if (primeWithBuffer && options.primingChunks) {
      for (const chunk of options.primingChunks) {
        stream.write(chunk);
        primedBytes += chunk.length;
      }
    }
    this.subscribers.add(stream);
    if (this.subscribers.size === 1) {
      this.upstream.resume();
    }
    const label = options.label ?? `sub-${++this.subscriberCounter}`;
    this.subscriberLabels.set(stream, label);
    const primedMs =
      options.pcmFrameRate &&
      options.pcmFrameRate.sampleRate > 0 &&
      options.pcmFrameRate.channels > 0 &&
      options.pcmFrameRate.bitDepth > 0
        ? Math.round(
            (primedBytes /
              (options.pcmFrameRate.sampleRate *
                options.pcmFrameRate.channels *
                (options.pcmFrameRate.bitDepth / 8))) *
              1000,
          )
        : null;
    this.log.debug('audio subscriber attached', {
      zoneId: options.zoneId,
      profile: options.profile,
      label,
      primeWithBuffer,
      primedBytes,
      primedMs,
      sessionBufferedBytes: options.sessionBufferedBytes,
      subscriberCount: this.subscribers.size,
    });
    const remove = () => {
      this.clearBackpressure(stream);
      if (this.subscribers.delete(stream)) {
        const tag = this.subscriberLabels.get(stream);
        this.subscriberLabels.delete(stream);
        this.log.debug('audio subscriber detached', {
          zoneId: options.zoneId,
          profile: options.profile,
          label: tag ?? label,
          subscriberCount: this.subscribers.size,
        });
        if (this.subscribers.size === 0) {
          this.upstream.pause();
        }
      }
    };
    stream.on('close', remove);
    stream.on('error', remove);
    return stream;
  }

  public write(chunk: Buffer): void {
    for (const subscriber of Array.from(this.subscribers)) {
      if (subscriber.writableEnded) {
        this.clearBackpressure(subscriber);
        this.subscribers.delete(subscriber);
        if (this.subscribers.size === 0) {
          this.upstream.pause();
        }
        continue;
      }
      const ok = subscriber.write(chunk);
      if (!ok) {
        const pending =
          (subscriber as { _writableState?: { length?: number } })?._writableState?.length ?? 0;
        this.addBackpressure(subscriber);
        if (pending > this.maxLagBytes) {
          subscriber.destroy();
          this.subscribers.delete(subscriber);
          this.clearBackpressure(subscriber);
          this.dropCount += 1;
          this.lastDropAt = Date.now();
        }
      }
    }
  }

  public endAll(discard: boolean): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.writableEnded) continue;
      if (discard) subscriber.destroy();
      else subscriber.end();
    }
    this.subscribers.clear();
  }

  public clearAllBackpressure(): void {
    for (const [sub, listener] of this.backpressureListeners.entries()) {
      sub.off('drain', listener);
    }
    this.backpressureListeners.clear();
    this.backpressureCount = 0;
  }

  private addBackpressure(subscriber: PassThrough): void {
    if (this.backpressureListeners.has(subscriber)) {
      return;
    }
    const onDrain = () => {
      this.clearBackpressure(subscriber);
    };
    this.backpressureListeners.set(subscriber, onDrain);
    this.backpressureCount += 1;
    subscriber.once('drain', onDrain);
    this.upstream.pause();
  }

  private clearBackpressure(subscriber: PassThrough): void {
    const onDrain = this.backpressureListeners.get(subscriber);
    if (!onDrain) {
      return;
    }
    subscriber.off('drain', onDrain);
    this.backpressureListeners.delete(subscriber);
    this.backpressureCount = Math.max(0, this.backpressureCount - 1);
    this.upstream.resume();
  }
}
