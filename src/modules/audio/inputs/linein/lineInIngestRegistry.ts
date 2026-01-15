import { PassThrough } from 'node:stream';
import { createLogger } from '@/core/logging/logger';

type LineInIngestSession = {
  id: string;
  stream: PassThrough;
  startedAt: number;
  bytesIn: number;
  stop: (reason?: string) => void;
};

type LineInIngestListener = (session: LineInIngestSession) => void;
type LineInIngestStopListener = (session: LineInIngestSession, reason?: string) => void;

class LineInIngestRegistry {
  private readonly log = createLogger('Audio', 'LineInIngest');
  private readonly sessions = new Map<string, LineInIngestSession>();
  private readonly listeners = new Map<string, Set<LineInIngestListener>>();
  private readonly stopListeners = new Map<string, Set<LineInIngestStopListener>>();
  private readonly anyStartListeners = new Set<LineInIngestListener>();

  public start(id: string, source: NodeJS.ReadableStream): LineInIngestSession {
    const trimmed = id.trim();
    const inputId = trimmed || 'unknown';
    const existing = this.sessions.get(inputId);
    if (existing) {
      existing.stop('replaced');
    }

    const stream = new PassThrough({ highWaterMark: 1024 * 64 });
    const session: LineInIngestSession = {
      id: inputId,
      stream,
      startedAt: Date.now(),
      bytesIn: 0,
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

    const onData = (chunk: Buffer) => {
      if (!chunk?.length) return;
      session.bytesIn += chunk.length;
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

export const lineInIngestRegistry = new LineInIngestRegistry();
