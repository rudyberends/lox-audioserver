import { PassThrough } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';

type LineInIngestSession = {
  id: string;
  stream: PassThrough;
  startedAt: number;
  bytesIn: number;
  format?: LineInIngestFormat;
  stop: (reason?: string) => void;
};

export type LineInIngestFormat = {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  pcmFormat: 's16le' | 's24le' | 's32le';
};

type LineInIngestListener = (session: LineInIngestSession) => void;
type LineInIngestStopListener = (session: LineInIngestSession, reason?: string) => void;

export class LineInIngestRegistry {
  private readonly log = createLogger('Audio', 'LineInIngest');
  private readonly sessions = new Map<string, LineInIngestSession>();
  private readonly listeners = new Map<string, Set<LineInIngestListener>>();
  private readonly stopListeners = new Map<string, Set<LineInIngestStopListener>>();
  private readonly anyStartListeners = new Set<LineInIngestListener>();

  public start(
    id: string,
    source: NodeJS.ReadableStream,
    options: { format?: LineInIngestFormat } = {},
  ): LineInIngestSession {
    const trimmed = id.trim();
    const inputId = trimmed || 'unknown';
    const existing = this.sessions.get(inputId);
    if (existing) {
      existing.stop('replaced');
    }

    const channels = options.format?.channels ?? 2;
    const bytesPerSample = options.format ? Math.max(1, Math.floor(options.format.bitDepth / 8)) : 2;
    const logIntervalMs = 5000;
    const stream = new PassThrough({ highWaterMark: 1024 * 64 });
    const session: LineInIngestSession = {
      id: inputId,
      stream,
      startedAt: Date.now(),
      bytesIn: 0,
      format: options.format,
      stop: (reason?: string) => {
        if (!this.sessions.has(inputId)) {
          return;
        }
        this.sessions.delete(inputId);
        try {
          source.unpipe(stream);
        } catch {
          /* ignore */
        }
        stream.end();
        this.notifyStopped(session, reason);
        if (reason) {
          this.log.info('line-in ingest stopped', { inputId, reason });
        }
      },
    };

    let bytesSinceLog = 0;
    let lastLogTs = 0;
    const onData = (chunk: Buffer) => {
      if (!chunk?.length) return;
      session.bytesIn += chunk.length;
      bytesSinceLog += chunk.length;
      const now = Date.now();
      if (!lastLogTs) {
        lastLogTs = now;
        return;
      }
      const elapsed = now - lastLogTs;
      if (elapsed >= logIntervalMs) {
        const bytesPerSec = Math.round((bytesSinceLog / elapsed) * 1000);
        const estimatedSampleRate = Math.round(bytesPerSec / (channels * bytesPerSample));
        this.log.info('line-in ingest throughput', {
          inputId,
          bytesPerSec,
          estimatedSampleRate,
          elapsedMs: elapsed,
        });
        lastLogTs = now;
        bytesSinceLog = 0;
      }
    };
    const onEnd = () => session.stop('ended');
    const onClose = () => session.stop('closed');
    const onError = (error: unknown) => {
      session.stop('error');
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('line-in ingest stream error', { inputId, message });
    };

    source.on('data', onData);
    source.on('end', onEnd);
    source.on('close', onClose);
    source.on('error', onError);
    source.pipe(stream);

    this.sessions.set(inputId, session);
    this.notifyStarted(session);
    this.log.info('line-in ingest started', { inputId });
    return session;
  }

  public getStream(id: string): PassThrough | null {
    const session = this.sessions.get(id.trim());
    return session?.stream ?? null;
  }

  public getSession(id: string): LineInIngestSession | null {
    return this.sessions.get(id.trim()) ?? null;
  }

  public stop(id: string, reason?: string): void {
    const session = this.sessions.get(id.trim());
    if (session) {
      session.stop(reason);
    }
  }

  public onStart(id: string, listener: LineInIngestListener): () => void {
    const inputId = id.trim();
    if (!inputId) {
      return () => {};
    }
    const bucket = this.listeners.get(inputId) ?? new Set<LineInIngestListener>();
    bucket.add(listener);
    this.listeners.set(inputId, bucket);
    return () => {
      const set = this.listeners.get(inputId);
      if (!set) return;
      set.delete(listener);
      if (!set.size) {
        this.listeners.delete(inputId);
      }
    };
  }

  public onAnyStart(listener: LineInIngestListener): () => void {
    this.anyStartListeners.add(listener);
    return () => {
      this.anyStartListeners.delete(listener);
    };
  }

  public getActiveSessions(): LineInIngestSession[] {
    return Array.from(this.sessions.values());
  }

  public onStop(id: string, listener: LineInIngestStopListener): () => void {
    const inputId = id.trim();
    if (!inputId) {
      return () => {};
    }
    const bucket = this.stopListeners.get(inputId) ?? new Set<LineInIngestStopListener>();
    bucket.add(listener);
    this.stopListeners.set(inputId, bucket);
    return () => {
      const set = this.stopListeners.get(inputId);
      if (!set) return;
      set.delete(listener);
      if (!set.size) {
        this.stopListeners.delete(inputId);
      }
    };
  }

  private notifyStarted(session: LineInIngestSession): void {
    const bucket = this.listeners.get(session.id);
    if (bucket?.size) {
      for (const listener of bucket) {
        try {
          listener(session);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log.warn('line-in ingest listener failed', { inputId: session.id, message });
        }
      }
    }
    if (this.anyStartListeners.size) {
      for (const listener of this.anyStartListeners) {
        try {
          listener(session);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log.warn('line-in ingest listener failed', { inputId: session.id, message });
        }
      }
    }
  }

  private notifyStopped(session: LineInIngestSession, reason?: string): void {
    const bucket = this.stopListeners.get(session.id);
    if (!bucket?.size) return;
    for (const listener of bucket) {
      try {
        listener(session, reason);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('line-in ingest stop listener failed', { inputId: session.id, message });
      }
    }
  }
}
