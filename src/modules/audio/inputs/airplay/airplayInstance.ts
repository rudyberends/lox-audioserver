import { createLogger, type ComponentLogger } from '@/core/logging/logger';
import type { ZoneAirplayConfig } from '@/domain/config/types';
import type { PlaybackMetadata, PlaybackSource, CoverArtPayload } from '@/modules/audio';
import { getPlayer } from '@/modules/audio/player/playerRegistry';
import os from 'node:os';
import http from 'node:http';
import { PassThrough } from 'stream';
import { startReceiver, stopReceiver } from '@lox-audioserver/node-libraop';
import type { RaopEvent, ReceiverOptions } from '@lox-audioserver/node-libraop/dist/types';

export interface AirplayInstanceController {
  startPlayback(
    zoneId: number,
    label: string,
    source: PlaybackSource,
    metadata?: PlaybackMetadata,
  ): void;
  updateMetadata(zoneId: number, metadata: Partial<PlaybackMetadata>): void;
  updateCover(zoneId: number, cover?: CoverArtPayload): string | void;
  updateVolume(zoneId: number, volume: number): void;
  updateTiming(zoneId: number, elapsed: number, duration: number): void;
  pausePlayback(zoneId: number): void;
  resumePlayback(zoneId: number): void;
  stopPlayback(zoneId: number): void;
}

const DEFAULT_SAMPLE_RATE = 44100;
const DEFAULT_CHANNELS = 2;

export class AirplayInstance {
  private readonly log: ComponentLogger;
  private readonly label: string;
  private readonly hardwareAddress: string;
  private zoneName: string;
  private stopping = false;
  private isPlaying = false;
  private currentMetadata: Partial<PlaybackMetadata> = {};
  private coverArt?: CoverArtPayload;
  private coverUrl?: string;
  private lastPublishedMetadata?: string;
  private currentVolume = 0;
  private sessionActive = false;
  private currentElapsedMs = 0;
  private currentDurationMs = 0;
  private receiverHandle: number | null = null;
  private httpRequest: http.ClientRequest | null = null;
  private httpResponse: http.IncomingMessage | null = null;
  private httpPort?: number;
  private httpHost?: string;
  private pcmStream: PassThrough | null = null;
  private pcmSampleRate = DEFAULT_SAMPLE_RATE;
  private pcmChannels = DEFAULT_CHANNELS;
  private pcmLogged = false;
  private pcmBytesTotal = 0;
  private lastTimingPushMs = 0;

  constructor(
    private readonly zoneId: number,
    zoneName: string,
    private readonly sourceMac: string,
    private config: ZoneAirplayConfig,
    private readonly controller: AirplayInstanceController,
  ) {
    this.zoneName = zoneName;
    this.log = createLogger('Input', `AirPlay][${zoneName}`);
    this.label = 'airplay';
    this.hardwareAddress = deriveHardwareAddress(sourceMac, zoneId);
  }

  public async start(): Promise<void> {
    if (this.receiverHandle !== null) {
      return;
    }
    await this.startServer();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    await this.stopServer();
    this.sessionActive = false;
    this.isPlaying = false;
    this.currentElapsedMs = 0;
    this.currentDurationMs = 0;
    this.pcmBytesTotal = 0;
    this.lastTimingPushMs = 0;
    this.stopping = false;
  }

  public async updateConfig(config: ZoneAirplayConfig): Promise<void> {
    if (this.config.port === config.port && this.config.enabled === config.enabled) {
      this.config = config;
      return;
    }
    this.config = config;
    await this.restart();
  }

  public async updateZoneName(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || trimmed === this.zoneName) {
      this.zoneName = trimmed || this.zoneName;
      return;
    }
    this.zoneName = trimmed;
    await this.restart();
  }

  private async restart(): Promise<void> {
    await this.stop();
    await this.start().catch((error) => {
      this.log.error('failed to restart airplay instance', {
        zoneId: this.zoneId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async startServer(): Promise<void> {
    const { portBase, portRange } = this.resolvePorts();
    const host = this.resolveHostAddress();
    const options: ReceiverOptions = {
      name: this.zoneName,
      model: this.config.model || 'LoxAudioAirplay',
      mac: this.hardwareAddress,
      metadata: true,
      portBase,
      portRange,
      host,
    };
    this.httpHost = host;
    this.log.info('starting AirPlay receiver', {
      zoneId: this.zoneId,
      portBase,
      portRange,
      host,
    });
    try {
      this.receiverHandle = startReceiver(options, (event) => this.handleRaopEvent(event));
      this.log.info('airplay receiver ready', {
        zoneId: this.zoneId,
        handle: this.receiverHandle,
      });
    } catch (error) {
      this.receiverHandle = null;
      this.log.error('failed to start airplay receiver', {
        zoneId: this.zoneId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async stopServer(): Promise<void> {
    if (this.receiverHandle !== null) {
      try {
        stopReceiver(this.receiverHandle);
      } catch (error) {
        this.log.warn('failed to stop airplay receiver', {
          zoneId: this.zoneId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.receiverHandle = null;
    this.stopHttpStream();
    this.httpPort = undefined;
    this.httpHost = undefined;
    this.endPcmStream();
  }

  private resolvePorts(): { portBase: number; portRange: number } {
    const base = typeof this.config.port === 'number' && this.config.port > 0 ? this.config.port : 6000 + (this.zoneId % 500);
    const portBase = base;
    const portRange = 100;
    return { portBase, portRange };
  }

  private resolveHostAddress(): string | undefined {
    const envHost = process.env.AIRPLAY_BIND_HOST;
    if (envHost && envHost.trim()) {
      return envHost.trim();
    }
    const interfaces = os.networkInterfaces();
    const normalizedMac = this.sourceMac.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
    let fallbackHost: string | undefined;
    for (const addresses of Object.values(interfaces)) {
      if (!addresses) {
        continue;
      }
      for (const addr of addresses) {
        if (addr.family !== 'IPv4' || addr.internal) {
          continue;
        }
        const addrMac = (addr.mac || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
        if (!fallbackHost) {
          fallbackHost = addr.address;
        }
        if (normalizedMac && addrMac === normalizedMac) {
          return addr.address;
        }
      }
    }
    return fallbackHost;
  }

  private handleRaopEvent(event: RaopEvent): void {
    switch (event.type) {
      case 'stream':
        this.log.info('airplay stream announced', { zoneId: this.zoneId, port: event.port });
        this.startHttpStream(event.port);
        break;
      case 'play':
        this.startHttpStream(this.httpPort);
        this.handlePlaybackStart();
        break;
      case 'pause':
        this.handlePlaybackPause();
        break;
      case 'flush':
        this.handlePlaybackPause();
        break;
      case 'stop':
        this.handlePlaybackStop();
        break;
      case 'volume':
        this.handleVolumeChange(event.value);
        break;
      case 'metadata':
        this.applyMetadataFromObject({
          title: event.title,
          artist: event.artist,
          album: event.album,
        });
        break;
      case 'artwork':
        this.applyMetadataFromObject({
          title: event.title,
          artist: event.artist,
          album: event.album,
          artwork: event.data,
        });
        break;
      case 'pcm':
        this.handlePcmFrame(event.data, event.sampleRate, event.channels);
        break;
      default:
        break;
    }
  }

  public markStopping(): void {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
  }

  /** Force-stop only the active AirPlay session/stream while keeping the receiver running. */
  public stopActiveSession(reason?: string): void {
    if (!this.sessionActive && !this.httpResponse) {
      return;
    }
    this.log.info('forcing airplay session stop', { zoneId: this.zoneId, reason });
    this.sessionActive = false;
    this.isPlaying = false;
    this.stopHttpStream();
    this.endPcmStream();
    const player = getPlayer(this.zoneId);
    if (player) {
      player.stop('airplay_forced_stop');
    } else {
      this.controller.stopPlayback(this.zoneId);
    }
    this.resetMetadata(true);
    if (reason?.startsWith('switch_to_')) {
      this.log.info('restarting airplay receiver to drop client', { zoneId: this.zoneId, reason });
      void this.restart();
    }
  }

  public sendRemoteCommand(
    command: 'Play' | 'Pause' | 'PlayPause' | 'Stop' | 'Next' | 'Previous' | 'ToggleMute',
  ): void {
    this.log.debug('remote command noop (airplay server)', { zoneId: this.zoneId, command });
  }

  public setRemoteVolume(percent: number): void {
    this.log.debug('remote volume noop (airplay server)', { zoneId: this.zoneId, percent });
  }

  private startHttpStream(port: number | undefined): void {
    if (!port || port <= 0) {
      return;
    }
    const host = this.httpHost || '127.0.0.1';
    if (this.httpPort === port && this.httpHost === host && this.httpResponse && !this.httpResponse.complete) {
      return;
    }
    this.stopHttpStream();
    this.httpPort = port;
    this.httpHost = host;
    this.log.info('connecting to airplay http stream', { zoneId: this.zoneId, host, port });
    const req = http.get(
      {
        host,
        port,
        path: '/',
        headers: {
          'Icy-MetaData': '0',
        },
      },
      (res) => {
        this.httpResponse = res;
        if (res.statusCode && res.statusCode >= 300) {
          this.log.warn('airplay http stream returned non-OK status', {
            zoneId: this.zoneId,
            status: res.statusCode,
          });
          this.stopHttpStream();
          return;
        }
        res.on('data', (chunk: Buffer) => this.handlePcmFrame(chunk));
        res.on('end', () => {
          this.log.info('airplay http stream ended', { zoneId: this.zoneId });
          this.stopHttpStream();
          if (!this.stopping) {
            this.handlePlaybackPause();
          }
        });
        res.on('error', (error) => {
          this.log.warn('airplay http stream error', {
            zoneId: this.zoneId,
            message: error instanceof Error ? error.message : String(error),
          });
          this.stopHttpStream();
        });
      },
    );
    req.on('error', (error) => {
      this.log.warn('airplay http request error', {
        zoneId: this.zoneId,
        message: error instanceof Error ? error.message : String(error),
      });
      this.stopHttpStream();
    });
    req.on('close', () => {
      this.httpRequest = null;
    });
    this.httpRequest = req;
  }

  private stopHttpStream(): void {
    if (this.httpResponse) {
      this.httpResponse.removeAllListeners();
      this.httpResponse.destroy();
    }
    if (this.httpRequest) {
      this.httpRequest.removeAllListeners();
      this.httpRequest.destroy();
    }
    this.httpResponse = null;
    this.httpRequest = null;
  }

  private handlePcmFrame(payload: Buffer, sampleRate?: number, channels?: number): void {
    if (!payload?.length) {
      return;
    }
    if (typeof sampleRate === 'number' && sampleRate > 0) {
      this.pcmSampleRate = sampleRate;
    }
    if (typeof channels === 'number' && channels > 0) {
      this.pcmChannels = channels;
    }
    if (!this.pcmStream) {
      this.pcmStream = new PassThrough({ highWaterMark: 512 * 1024 });
    }
    if (!this.sessionActive) {
      this.handlePlaybackStart();
    }
    const ok = this.pcmStream.write(payload);
    if (!ok) {
      this.log.debug('backpressure on pcm stream', { zoneId: this.zoneId });
    }
    if (!this.pcmLogged) {
      this.pcmLogged = true;
      this.log.info('airplay pcm stream started', {
        zoneId: this.zoneId,
        sampleRate: this.pcmSampleRate,
        channels: this.pcmChannels,
        bytes: payload.length,
      });
    }
    this.log.spam?.('airplay pcm chunk', {
      zoneId: this.zoneId,
      bytes: payload.length,
      sampleRate: this.pcmSampleRate,
      channels: this.pcmChannels,
    });
    this.handlePcmTimingUpdate(payload.length);
  }

  private handleVolumeChange(raw: number): void {
    if (!Number.isFinite(raw)) {
      return;
    }
    const interpreted =
      raw <= 1 && raw >= 0 ? Math.round(raw * 100) : raw <= 0 && raw >= -144 ? mapDbToPercent(raw) : Math.round(raw);
    const volume = Math.max(0, Math.min(100, interpreted));
    if (volume === this.currentVolume) {
      return;
    }
    this.currentVolume = volume;
    this.log.info('airplay volume changed', {
      zoneId: this.zoneId,
      raw,
      volume,
    });
    const player = getPlayer(this.zoneId);
    if (player) {
      player.setVolume(volume);
    } else {
      this.controller.updateVolume(this.zoneId, volume);
    }
  }

  private applyMetadataFromObject(metadata: Record<string, unknown>): void {
    const readString = (keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = metadata[key];
        if (typeof value === 'string' && value.trim()) {
          return value.trim();
        }
      }
      return undefined;
    };
    const readNumber = (keys: string[]): number | undefined => {
      for (const key of keys) {
        const value = metadata[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
          return value;
        }
        if (typeof value === 'string') {
          const parsed = Number(value);
          if (Number.isFinite(parsed)) {
            return parsed;
          }
        }
      }
      return undefined;
    };

    const title = readString(['title', 'name', 'songName', 'Song Name']);
    const artist = readString(['artist', 'Artist']);
    const album = readString(['album', 'albumName', 'Album']);
    if (title) {
      this.currentMetadata.title = title;
    }
    if (artist) {
      this.currentMetadata.artist = artist;
    }
    if (album) {
      this.currentMetadata.album = album;
    }

    const artwork =
      (metadata as any).artworkData ??
      (metadata as any).artwork?.data ??
      (metadata as any)['artwork-data'] ??
      (metadata as any).artwork;
    const artworkMime =
      readString(['artworkMIMETYPE', 'artworkMime', 'artworkType']) ?? (this.coverArt?.mime ?? undefined);
    if (artwork) {
      try {
        const buf = Buffer.isBuffer(artwork)
          ? artwork
          : typeof artwork === 'string'
            ? Buffer.from(artwork, 'base64')
            : null;
        if (buf?.length) {
          this.coverArt = { data: buf, mime: artworkMime ?? detectMimeType(buf) };
          const coverUrl = this.controller.updateCover(this.zoneId, this.coverArt);
          this.coverUrl = typeof coverUrl === 'string' ? coverUrl : undefined;
          this.log.info('airplay cover art updated', {
            zoneId: this.zoneId,
            bytes: buf.length,
            mime: this.coverArt.mime,
          });
        }
      } catch {
        // ignore artwork parse failures
      }
    }

    const durationSeconds = readNumber(['duration', 'totalTime', 'length']);
    if (durationSeconds && durationSeconds > 0) {
      this.currentDurationMs = Math.round(durationSeconds * 1000);
      this.currentMetadata.duration = this.currentDurationMs;
    }
    const elapsedSeconds = readNumber(['position', 'elapsedTime', 'progress', 'playbackPosition']);
    if (elapsedSeconds !== undefined) {
      const elapsedMs = Math.max(0, Math.round(elapsedSeconds * 1000));
      this.currentElapsedMs = elapsedMs;
      const player = getPlayer(this.zoneId);
      if (player) {
        player.updateTiming(elapsedMs, this.currentDurationMs);
      } else {
        this.controller.updateTiming(this.zoneId, elapsedMs, this.currentDurationMs);
      }
    }

    this.publishMetadata();
  }

  private handlePlaybackStart(): void {
    if (!this.sessionActive) {
      if (this.httpPort) {
        this.startHttpStream(this.httpPort);
      }
      if (!this.pcmStream) {
        this.pcmStream = new PassThrough({ highWaterMark: 512 * 1024 });
      }
      this.sessionActive = true;
      this.isPlaying = true;
      const playbackSource: PlaybackSource = {
        kind: 'pipe',
        path: `airplay-${this.zoneId}`,
        format: 's16le',
        sampleRate: this.pcmSampleRate,
        channels: this.pcmChannels,
        stream: this.pcmStream,
      };
      // Always go through the controller so the zone manager can mark the active input
      // and keep Spotify transports quiet while AirPlay owns the zone.
      this.controller.startPlayback(
        this.zoneId,
        this.label,
        playbackSource,
        this.buildPlaybackMetadata(),
      );
      this.pcmBytesTotal = 0;
      this.lastTimingPushMs = Date.now();
      this.currentElapsedMs = 0;
      this.currentDurationMs = this.currentMetadata.duration || 0;
      this.publishMetadata();
      return;
    }
    if (!this.isPlaying) {
      this.handlePlaybackResume();
    }
  }

  private handlePlaybackResume(): void {
    if (!this.sessionActive || this.isPlaying) {
      return;
    }
    this.isPlaying = true;
    const player = getPlayer(this.zoneId);
    if (player) {
      player.resume();
    } else {
      this.controller.resumePlayback(this.zoneId);
    }
  }

  private handlePlaybackPause(): void {
    if (!this.sessionActive || !this.isPlaying) {
      return;
    }
    this.isPlaying = false;
    const player = getPlayer(this.zoneId);
    if (player) {
      player.pause();
    } else {
      this.controller.pausePlayback(this.zoneId);
    }
  }

  private handlePlaybackStop(): void {
    if (!this.sessionActive) {
      return;
    }
    this.sessionActive = false;
    this.isPlaying = false;
    this.stopHttpStream();
    this.endPcmStream();
    const player = getPlayer(this.zoneId);
    if (player) {
      player.stop('airplay_stop');
    } else {
      this.controller.stopPlayback(this.zoneId);
    }
    this.resetMetadata(true);
  }

  private buildPlaybackMetadata(): PlaybackMetadata {
    const fallbackTitle = `${this.zoneName} (AirPlay)`;
    return {
      title: this.currentMetadata.title || fallbackTitle,
      artist: this.currentMetadata.artist ?? '',
      album: this.currentMetadata.album ?? '',
      coverurl: this.coverUrl,
    };
  }

  private publishMetadata(): void {
    const metadata = this.buildPlaybackMetadata();
    const serialized = JSON.stringify(metadata);
    const changed = serialized !== this.lastPublishedMetadata;
    if (changed) {
      this.lastPublishedMetadata = serialized;
    }
    if (changed) {
      this.log.info('airplay metadata updated', {
        zoneId: this.zoneId,
        title: metadata.title,
        artist: metadata.artist,
        album: metadata.album,
        cover: Boolean(metadata.coverurl),
        changed,
      });
    }
    const player = getPlayer(this.zoneId);
    if (player) {
      player.updateMetadata(metadata);
    } else {
      this.controller.updateMetadata(this.zoneId, metadata);
    }
  }

  private resetMetadata(clearCoverArt = false): void {
    this.currentMetadata = {};
    this.currentElapsedMs = 0;
    this.currentDurationMs = 0;
    this.pcmLogged = false;
    this.pcmBytesTotal = 0;
    this.lastTimingPushMs = 0;
    // Do not push timing resets while an AirPlay session is bouncing; only reset when fully stopped.
    if (!this.sessionActive) {
      this.controller.updateTiming(this.zoneId, 0, 0);
    }
    if (clearCoverArt) {
      this.coverArt = undefined;
      const player = getPlayer(this.zoneId);
      if (player) {
        player.updateCover(undefined);
      } else {
        const coverUrl = this.controller.updateCover(this.zoneId, undefined);
        this.coverUrl = typeof coverUrl === 'string' ? coverUrl : undefined;
      }
    }
    this.lastPublishedMetadata = undefined;
  }

  private endPcmStream(): void {
    if (!this.pcmStream) {
      return;
    }
    try {
      this.pcmStream.end();
      this.pcmStream.destroy();
    } catch {
      // ignore
    }
    this.pcmStream = null;
    this.pcmLogged = false;
    this.pcmBytesTotal = 0;
    this.lastTimingPushMs = 0;
  }

  private handlePcmTimingUpdate(bytes: number): void {
    if (!bytes || bytes <= 0) {
      return;
    }
    const sampleRate = this.pcmSampleRate || DEFAULT_SAMPLE_RATE;
    const channels = this.pcmChannels || DEFAULT_CHANNELS;
    const bytesPerFrame = channels * 2; // 16-bit samples
    if (bytesPerFrame <= 0 || sampleRate <= 0) {
      return;
    }
    this.pcmBytesTotal += bytes;
    const elapsedSeconds = Math.floor(this.pcmBytesTotal / (bytesPerFrame * sampleRate));
    const elapsedMs = elapsedSeconds * 1000;
    const durationMs = this.currentDurationMs || this.currentMetadata.duration || 0;
    const now = Date.now();
    const shouldPublish =
      elapsedMs !== this.currentElapsedMs || now - this.lastTimingPushMs >= 1000;
    if (!shouldPublish) {
      return;
    }
    this.currentElapsedMs = elapsedMs;
    this.lastTimingPushMs = now;
    const player = getPlayer(this.zoneId);
    if (player) {
      player.updateTiming(elapsedMs, durationMs);
    } else {
      this.controller.updateTiming(this.zoneId, elapsedMs, durationMs);
    }
  }

}

function detectMimeType(buffer: Buffer): string {
  if (!buffer?.length) {
    return 'image/jpeg';
  }
  if (buffer.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    return 'image/png';
  }
  if (buffer.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return 'image/jpeg';
  }
  return 'image/jpeg';
}

function deriveHardwareAddress(sourceMac: string, zoneId: number): string {
  const fallback = '504f94ff0000';
  const cleaned = (sourceMac || fallback).replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  const normalized = (cleaned.length >= 12 ? cleaned.slice(-12) : (cleaned + fallback).slice(0, 12));
  const bytes: number[] = [];
  for (let i = 0; i < 6; i++) {
    const slice = normalized.slice(i * 2, i * 2 + 2);
    const value = Number.parseInt(slice, 16);
    bytes.push(Number.isFinite(value) ? value : 0);
  }
  bytes[5] = (bytes[5] + (zoneId & 0xff)) & 0xff;
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(':');
}

function mapDbToPercent(db: number): number {
  if (db <= -144) {
    return 0;
  }
  const pct = Math.round(((db + 30) / 30) * 100);
  return Math.max(0, Math.min(100, pct));
}
