import { PassThrough } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import type { EngineLocalSession, EnginePort } from '@/ports/EnginePort';
import type { PlaybackSource } from '@/ports/EngineTypes';
import type { AudioOutputSettings } from '@/ports/types/audioFormat';

/**
 * Minimal shared PCM stream session for AirPlay.
 * Keeps a single subscriber to the audio engine alive across track changes
 * so outputs do not thrash the engine with new readers.
 */
export class AirplayStreamSession {
  private readonly log = createLogger('Output', 'AirPlayStreamSession');
  private stream: PassThrough | null = null;
  private source: PassThrough | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private localSourceKey: string | null = null;
  private localPlaybackSource: PlaybackSource | null = null;
  private localOutputSettings: AudioOutputSettings | null = null;
  private localSession: EngineLocalSession | null = null;

  constructor(
    private readonly zoneId: number,
    private readonly engine: EnginePort,
  ) {}

  /**
   * Obtain a PCM PassThrough for this zone. Keeps a persistent stream open so
   * AirPlay does not see end-of-stream on track switches.
   */
  public getStream(): PassThrough | null {
    if (this.stream && !this.stream.destroyed) {
      this.ensureSource();
      return this.stream;
    }
    const next = new PassThrough({ highWaterMark: 1024 * 512 });
    this.stream = next;
    this.ensureSource();
    next.once('close', () => {
      this.stream = null;
    });
    next.once('error', (err) => {
      this.log.warn('airplay stream session error', {
        zoneId: this.zoneId,
        message: err instanceof Error ? err.message : String(err),
      });
      this.stream = null;
    });
    return this.stream;
  }

  public setPlaybackSource(
    playbackSource: PlaybackSource | null,
    outputSettings: AudioOutputSettings,
  ): void {
    const useLocal = playbackSource?.kind === 'url';
    const nextKey = useLocal
      ? [
          playbackSource.url,
          playbackSource.inputFormat ?? '',
          String(outputSettings.sampleRate),
          String(outputSettings.channels),
          String(outputSettings.pcmBitDepth),
        ].join('|')
      : null;
    if (nextKey === this.localSourceKey) {
      return;
    }
    this.localSourceKey = nextKey;
    this.localPlaybackSource = useLocal
      ? { ...playbackSource, realTime: true }
      : null;
    this.localOutputSettings = useLocal ? outputSettings : null;
    this.stopLocalSession();
    if (this.stream && !this.stream.destroyed) {
      this.ensureSource();
    }
  }

  private ensureSource(): void {
    if (!this.stream || this.stream.destroyed) return;
    if (this.source && !this.source.destroyed && !(this.source as any).readableEnded) {
      return;
    }
    const next = this.createSourceStream();
    if (!next) {
      this.source = null;
      this.scheduleReconnect();
      return;
    }
    this.attachSource(next);
  }

  private createSourceStream(): PassThrough | null {
    if (this.localPlaybackSource) {
      if (!this.localSession) {
        this.startLocalSession();
      }
      const subscriber = this.localSession?.createSubscriber({
        label: 'airplay-local',
        primeWithBuffer: false,
      });
      return subscriber ?? null;
    }
    return this.engine.createStream(this.zoneId, 'pcm', { label: 'airplay' });
  }

  private startLocalSession(): void {
    if (!this.localPlaybackSource || !this.localOutputSettings) {
      return;
    }
    this.stopLocalSession();
    this.localSession = this.engine.createLocalSession(
      this.zoneId,
      this.localPlaybackSource,
      'pcm',
      this.localOutputSettings,
      () => {
        /* handled by reconnect */
      },
    );
    this.localSession.start();
  }

  private stopLocalSession(): void {
    if (!this.localSession) {
      return;
    }
    this.localSession.stop();
    this.localSession = null;
  }

  private attachSource(next: PassThrough): void {
    this.clearReconnect();
    this.reconnectAttempts = 0;
    this.source = next;
    next.on('data', (chunk: Buffer) => {
      if (!chunk?.length || !this.stream || this.stream.destroyed) return;
      this.stream.write(chunk);
    });
    const cleanup = () => {
      if (this.source === next) {
        this.source = null;
      }
      this.scheduleReconnect();
    };
    next.once('end', cleanup);
    next.once('close', cleanup);
    next.once('error', (err) => {
      this.log.warn('airplay source stream error', {
        zoneId: this.zoneId,
        message: err instanceof Error ? err.message : String(err),
      });
      cleanup();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.stream || this.stream.destroyed) {
      return;
    }
    const delay = Math.min(1000, 100 + this.reconnectAttempts * 100);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stream || this.stream.destroyed) return;
      const next = this.createSourceStream();
      if (next) {
        this.attachSource(next);
        return;
      }
      this.reconnectAttempts += 1;
      this.scheduleReconnect();
    }, delay);
  }

  private clearReconnect(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  public dispose(): void {
    this.clearReconnect();
    this.stopLocalSession();
    if (this.source && !this.source.destroyed) {
      try {
        this.source.destroy();
      } catch {
        /* ignore */
      }
    }
    this.source = null;
    if (this.stream && !this.stream.destroyed) {
      try {
        this.stream.destroy();
      } catch {
        /* ignore */
      }
    }
    this.stream = null;
  }
}
