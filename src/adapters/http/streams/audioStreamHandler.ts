import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import type { AudioManager, PlaybackSession } from '@/application/playback/audioManager';
import type { EnginePort } from '@/ports/EnginePort';
import type { OutputProfile } from '@/ports/EngineTypes';
import { resolveSessionCover, isHttpUrl } from '@/shared/coverArt';
import {
  audioOutputSettings,
  buildWavHeader,
  mp3BitrateToBps,
  type HttpProfile,
  type AudioOutputSettings,
} from '@/ports/types/audioFormat';
import type { StreamEvents } from '@/adapters/http/streams/streamEvents';

/**
 * Serves `/streams/:zone/:id` endpoints backed by the audio manager sessions.
 */
export class AudioStreamHandler {
  private readonly log = createLogger('Http', 'Streams');
  private readonly syncStreams = new Map<string, SyncStreamEntry>();

  constructor(
    private readonly engine: EnginePort,
    private readonly streamEvents: StreamEvents,
    private readonly audioManager: AudioManager,
  ) {}

  public matches(pathname: string): boolean {
    return pathname.startsWith('/streams/');
  }

  public async handle(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const [, , zoneStr, rawStream, extra] = pathname.split('/');
    const streamToken = rawStream?.split(/[?#]/)[0] ?? '';
    const resourceToken = extra?.split(/[?#]/)[0] ?? '';
    const streamId = this.stripExtension(streamToken);
    const isWav = streamToken.endsWith('.wav');
    const isAac = streamToken.endsWith('.aac');
    const zoneId = Number(zoneStr);
    const isCoverRequest = resourceToken === 'cover';
    if (!Number.isFinite(zoneId) || !streamId) {
      this.notFound(res);
      return;
    }

    const session = this.audioManager.getSession(zoneId);
    if (!session) {
      this.log.debug('no active session for stream request', { zoneId, streamId });
      this.notFound(res);
      return;
    }
    const activeIds = [session.stream.id, session.pcmStream?.id].filter(Boolean) as string[];
    const requestedMatches =
      streamId === 'current' ? true : activeIds.includes(streamId);
    if (!requestedMatches) {
      this.log.debug('stream id mismatch', {
        zoneId,
        requested: streamId,
        active: activeIds,
      });
      this.notFound(res);
      return;
    }

    if (isCoverRequest) {
      await this.handleCoverRequest(res, session);
      return;
    }

    const outputSettings = this.audioManager.getEffectiveOutputSettings(zoneId);
    const httpPrefs = this.audioManager.getHttpPreferences(zoneId);
    const httpProfile = httpPrefs?.httpProfile ?? audioOutputSettings.httpProfile;
    const icyEnabledOverride = httpPrefs?.icyEnabled ?? audioOutputSettings.httpIcyEnabled;
    const icyIntervalOverride = httpPrefs?.icyInterval ?? audioOutputSettings.httpIcyInterval;
    const icyNameOverride = httpPrefs?.icyName ?? audioOutputSettings.httpIcyName;

    const outputProfile = isWav ? 'pcm' : isAac ? 'aac' : 'mp3';
    const syncParams = this.parseSyncParams(req.url ?? '');
    if (syncParams && outputProfile === 'mp3') {
      await this.handleSyncStream(req, res, session, zoneId, 'mp3', outputSettings, httpProfile, {
        icyEnabledOverride,
        icyIntervalOverride,
        icyNameOverride,
      }, syncParams);
      return;
    }
    const clientLabel = this.buildClientLabel(req, outputProfile);
    const primeWithBuffer = this.shouldPrimeWithBuffer(req);
    let audioStream = this.engine.createStream(zoneId, outputProfile, {
      label: clientLabel,
      primeWithBuffer,
    });
    if (!audioStream && session.playbackSource) {
      const profiles =
        session.playbackSource.kind === 'pipe'
          ? (['mp3', 'pcm'] as const)
          : (['mp3', 'pcm'] as const);
      const withAac = isAac ? (['aac', ...profiles] as const) : profiles;
      this.engine.start(zoneId, session.playbackSource, withAac as any);
      audioStream = this.engine.createStream(zoneId, outputProfile, {
        label: clientLabel,
        primeWithBuffer,
      });
    }
    if (!audioStream) {
      this.log.warn('audio engine stream unavailable', { zoneId });
      this.engineUnavailable(res);
      return;
    }

    const contentType = isWav ? 'audio/wav' : isAac ? 'audio/aac' : 'audio/mpeg';
    this.streamEvents.recordStreamRequest({
      zoneId,
      streamId,
      url: req.url ?? '',
      remoteAddress: req.socket?.remoteAddress ?? null,
    });
    const durationSeconds = this.resolveDurationSeconds(session);
    const icyEnabled = this.shouldUseIcy(req, icyEnabledOverride);
    const contentLength = icyEnabled
      ? null
      : this.estimateContentLength(
          outputProfile,
          durationSeconds,
          httpProfile,
          outputSettings,
        );
    const useChunked = this.shouldUseChunked(httpProfile);

    this.writeHeaders(res, contentType, {
      contentLength,
      chunked: useChunked,
      icy: icyEnabled,
      icyInterval: icyIntervalOverride,
      icyName: icyNameOverride,
    });

    // PCM profile is raw PCM at configured format; for .wav requests we prepend a lightweight WAV header.
    if (isWav) {
      const header = buildWavHeader({
        sampleRate: outputSettings.sampleRate,
        channels: outputSettings.channels,
        bitDepth: outputSettings.pcmBitDepth,
      });
      res.write(header);
    }
    if (icyEnabled) {
      this.pipeWithIcyMetadata(req, res, audioStream, session, icyIntervalOverride, icyNameOverride);
    } else {
      audioStream.pipe(res);
    }

    const dispose = () => {
      audioStream.destroy();
    };

    req.on('close', dispose);
    req.on('aborted', dispose);
    res.on('close', dispose);
    audioStream.on('error', (error) => {
      this.log.warn('stream pipe error', {
        zoneId,
        streamId,
        message: error instanceof Error ? error.message : String(error),
      });
      dispose();
    });
  }

  private async handleCoverRequest(res: ServerResponse, session: PlaybackSession): Promise<void> {
    if (session.cover) {
      res.writeHead(200, {
        'Content-Type': session.cover.mime || 'image/jpeg',
        'Cache-Control': 'no-cache',
      });
      res.end(session.cover.data);
      return;
    }
    const coverSource = resolveSessionCover(session);
    if (!coverSource) {
      this.coverUnavailable(res);
      return;
    }
    if (coverSource.startsWith('data:')) {
      this.serveDataUri(res, coverSource);
      return;
    }
    if (isHttpUrl(coverSource)) {
      await this.proxyCoverFromHttp(res, coverSource);
      return;
    }
    this.coverUnavailable(res);
  }

  private serveDataUri(res: ServerResponse, dataUri: string): void {
    const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUri);
    if (!match) {
      this.coverUnavailable(res);
      return;
    }
    const [, mime, payload] = match;
    res.writeHead(200, {
      'Content-Type': mime || 'image/jpeg',
      'Cache-Control': 'no-cache',
    });
    res.end(Buffer.from(payload, 'base64'));
  }

  private async proxyCoverFromHttp(res: ServerResponse, source: string): Promise<void> {
    try {
      const response = await fetch(source);
      if (!response.ok || !response.body) {
        this.coverUnavailable(res);
        return;
      }
      const contentType = response.headers.get('content-type') ?? 'image/jpeg';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
      });
      const stream = Readable.fromWeb(response.body as any);
      stream.on('error', (error) => {
        this.log.warn('cover proxy stream failed', {
          message: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          this.coverUnavailable(res);
        } else {
          res.destroy(error as Error);
        }
      });
      stream.pipe(res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('cover proxy failed', { source, message });
      this.coverUnavailable(res);
    }
  }

  private writeHeaders(
    res: ServerResponse,
    contentType = 'audio/mpeg',
    options: {
      contentLength?: number | null;
      chunked?: boolean;
      icy?: boolean;
      icyInterval?: number;
      icyName?: string;
    } = {},
  ): void {
    const headers: Record<string, string | number> = {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'Accept-Ranges': 'none',
      Connection: 'close',
      'transferMode.dlna.org': 'Streaming',
      'contentFeatures.dlna.org':
        'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01500000000000000000000000000000',
    };
    if (options.chunked) {
      headers['Transfer-Encoding'] = 'chunked';
    } else if (options.contentLength && options.contentLength > 0) {
      headers['Content-Length'] = options.contentLength;
    }
    if (options.icy) {
      headers['icy-metaint'] = options.icyInterval ?? audioOutputSettings.httpIcyInterval;
      headers['icy-name'] = options.icyName ?? audioOutputSettings.httpIcyName;
    }
    res.writeHead(200, headers);
  }

  private notFound(res: ServerResponse): void {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'stream-not-found' }));
  }

  private coverUnavailable(res: ServerResponse): void {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('cover-not-found');
  }

  private engineUnavailable(res: ServerResponse): void {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'audio-engine-unavailable',
        message: 'No active audio stream. Ensure ffmpeg is installed and playback is running.',
      }),
    );
  }

  private stripExtension(value: string): string {
    if (!value) {
      return '';
    }
    const dotIndex = value.indexOf('.');
    return dotIndex > 0 ? value.slice(0, dotIndex) : value;
  }

  private resolveDurationSeconds(session: PlaybackSession): number | null {
    if (session?.duration && session.duration > 0) {
      return session.duration;
    }
    if (session?.metadata?.duration && session.metadata.duration > 0) {
      return session.metadata.duration;
    }
    return null;
  }

  private shouldUseChunked(profile: HttpProfile): boolean {
    return profile === 'chunked';
  }

  private buildClientLabel(req: IncomingMessage, profile: OutputProfile): string {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const agent = (req.headers['user-agent'] ?? '').toString();
    const shortAgent = agent ? agent.split(/\s+/).slice(0, 2).join('/') : '';
    return `http:${ip}:${profile}${shortAgent ? `:${shortAgent}` : ''}`;
  }

  private shouldUseIcy(req: IncomingMessage, icyEnabled: boolean): boolean {
    if (!icyEnabled) {
      return false;
    }
    const header = req.headers['icy-metadata'] ?? req.headers['icy-metadata'.toLowerCase()];
    return String(header ?? '').trim() === '1';
  }

  private shouldPrimeWithBuffer(req: IncomingMessage): boolean {
    const rawUrl = req.url ?? '';
    if (!rawUrl) {
      return true;
    }
    try {
      const url = new URL(rawUrl, 'http://localhost');
      const value = url.searchParams.get('prime');
      if (value === '0' || value === 'false') {
        return false;
      }
    } catch {
      return true;
    }
    return true;
  }

  private pipeWithIcyMetadata(
    req: IncomingMessage,
    res: ServerResponse,
    audioStream: NodeJS.ReadableStream & { destroy?: (error?: Error) => void },
    session: PlaybackSession,
    intervalOverride?: number,
    nameOverride?: string,
  ): void {
    const interval = Math.max(
      1024,
      intervalOverride ?? audioOutputSettings.httpIcyInterval ?? 0,
    );
    let bytesUntilMeta = interval;

    const writeMetadata = () => {
      const meta = this.buildIcyBlock(session);
      if (meta) {
        res.write(meta);
      }
    };

    const onData = (chunk: Buffer) => {
      let offset = 0;
      while (offset < chunk.length) {
        const remaining = bytesUntilMeta;
        const toWrite = Math.min(remaining, chunk.length - offset);
        res.write(chunk.subarray(offset, offset + toWrite));
        offset += toWrite;
        bytesUntilMeta -= toWrite;
        if (bytesUntilMeta <= 0) {
          writeMetadata();
          bytesUntilMeta = interval;
        }
      }
    };

    const dispose = () => {
      audioStream.off('data', onData);
      if (typeof audioStream.destroy === 'function') {
        audioStream.destroy();
      }
      if (!res.writableEnded) {
        res.end();
      }
    };

    audioStream.on('data', onData);
    audioStream.on('end', () => res.end());
    audioStream.on('close', () => res.end());
    audioStream.on('error', () => dispose());
    req.on('close', dispose);
    req.on('aborted', dispose);
    res.on('close', dispose);
  }

  private buildIcyBlock(session: PlaybackSession): Buffer | null {
    const title = session.metadata?.title;
    const artist = session.metadata?.artist;
    const text = title && artist ? `${artist} - ${title}` : title || session.source || 'Audio';
    const safe = (text ?? '').replace(/\s+/g, ' ').trim();
    const payload = `StreamTitle='${safe.replace(/'/g, '')}';`;
    const raw = Buffer.from(payload, 'utf8');
    const maxLen = 255 * 16;
    const trimmed = raw.length > maxLen ? raw.subarray(0, maxLen) : raw;
    const paddedLength = Math.ceil(trimmed.length / 16) * 16;
    const padded = Buffer.alloc(1 + paddedLength, 0);
    padded.writeUInt8(paddedLength / 16, 0);
    trimmed.copy(padded, 1);
    return padded;
  }

  private estimateContentLength(
    profile: 'pcm' | 'mp3' | 'aac',
    durationSeconds: number | null,
    httpProfile: HttpProfile,
    output: AudioOutputSettings,
  ): number | null {
    if (httpProfile !== 'forced_content_length') {
      return null;
    }
    const duration = durationSeconds ?? output.httpFallbackSeconds;
    if (!Number.isFinite(duration) || duration <= 0) {
      return null;
    }
    if (profile === 'pcm') {
      const bytesPerSecond =
        output.sampleRate *
        output.channels *
        (output.pcmBitDepth / 8);
      return Math.round(bytesPerSecond * duration);
    }
    const bps = mp3BitrateToBps(output.mp3Bitrate);
    if (bps <= 0) {
      return null;
    }
    return Math.round((bps / 8) * duration);
  }

  private parseSyncParams(rawUrl: string): { syncId: string; expected: number } | null {
    if (!rawUrl) return null;
    try {
      const url = new URL(rawUrl, 'http://localhost');
      const syncId = url.searchParams.get('sync');
      const expected = Number(url.searchParams.get('expect') ?? '');
      if (!syncId || !Number.isFinite(expected) || expected < 2) {
        return null;
      }
      return { syncId, expected: Math.floor(expected) };
    } catch {
      return null;
    }
  }

  private async handleSyncStream(
    req: IncomingMessage,
    res: ServerResponse,
    session: PlaybackSession,
    zoneId: number,
    outputProfile: 'mp3',
    outputSettings: AudioOutputSettings,
    httpProfile: HttpProfile,
    icyOverrides: { icyEnabledOverride: boolean; icyIntervalOverride?: number; icyNameOverride?: string },
    sync: { syncId: string; expected: number },
  ): Promise<void> {
    const contentType = 'audio/mpeg';
    const durationSeconds = this.resolveDurationSeconds(session);
    const icyEnabled = this.shouldUseIcy(req, icyOverrides.icyEnabledOverride);
    const contentLength = icyEnabled
      ? null
      : this.estimateContentLength(
          outputProfile,
          durationSeconds,
          httpProfile,
          outputSettings,
        );
    const useChunked = this.shouldUseChunked(httpProfile);

    let entry: SyncStreamEntry;
    try {
      entry = this.getOrCreateSyncEntry(
        sync.syncId,
        zoneId,
        outputProfile,
        outputSettings,
        session,
        sync.expected,
      );
    } catch {
      this.engineUnavailable(res);
      return;
    }
    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const passThrough = new PassThrough();

    entry.clients.set(clientId, {
      req,
      res,
      passThrough,
      icyEnabled,
      icyInterval: icyOverrides.icyIntervalOverride,
      icyName: icyOverrides.icyNameOverride,
    });

    this.writeHeaders(res, contentType, {
      contentLength,
      chunked: useChunked,
      icy: icyEnabled,
      icyInterval: icyOverrides.icyIntervalOverride,
      icyName: icyOverrides.icyNameOverride,
    });

    const cleanup = () => this.removeSyncClient(sync.syncId, clientId);
    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);

    if (entry.clients.size >= entry.expectedCount) {
      this.startSyncEntry(entry);
    }
  }

  private getOrCreateSyncEntry(
    syncId: string,
    zoneId: number,
    outputProfile: 'mp3',
    outputSettings: AudioOutputSettings,
    session: PlaybackSession,
    expectedCount: number,
  ): SyncStreamEntry {
    const existing = this.syncStreams.get(syncId);
    if (existing) {
      existing.expectedCount = Math.max(existing.expectedCount, expectedCount);
      return existing;
    }

    const clientLabel = `sync:${syncId}`;
    let audioStream = this.engine.createStream(zoneId, outputProfile, {
      label: clientLabel,
      primeWithBuffer: true,
    });
    if (!audioStream && session.playbackSource) {
      this.engine.start(zoneId, session.playbackSource, ['mp3', 'pcm'] as any);
      audioStream = this.engine.createStream(zoneId, outputProfile, {
        label: clientLabel,
        primeWithBuffer: true,
      });
    }
    if (!audioStream) {
      throw new Error('sync stream unavailable');
    }

    const entry: SyncStreamEntry = {
      id: syncId,
      zoneId,
      outputProfile,
      outputSettings,
      session,
      expectedCount,
      clients: new Map(),
      stream: audioStream,
      started: false,
      timeoutId: setTimeout(() => this.startSyncEntry(entry), 10000),
    };
    audioStream.on('error', (error) => {
      this.log.warn('sync stream error', {
        syncId,
        zoneId,
        message: error instanceof Error ? error.message : String(error),
      });
      this.cleanupSyncEntry(entry);
    });
    audioStream.on('end', () => this.cleanupSyncEntry(entry));
    audioStream.on('close', () => this.cleanupSyncEntry(entry));

    this.syncStreams.set(syncId, entry);
    return entry;
  }

  private startSyncEntry(entry: SyncStreamEntry): void {
    if (entry.started) return;
    entry.started = true;
    clearTimeout(entry.timeoutId);
    const stream = entry.stream;

    for (const client of entry.clients.values()) {
      if (client.icyEnabled) {
        this.pipeWithIcyMetadata(
          client.req,
          client.res,
          client.passThrough,
          entry.session,
          client.icyInterval,
          client.icyName,
        );
      } else {
        client.passThrough.pipe(client.res);
      }
      stream.pipe(client.passThrough, { end: true });
    }
  }

  private removeSyncClient(syncId: string, clientId: string): void {
    const entry = this.syncStreams.get(syncId);
    if (!entry) return;
    entry.clients.delete(clientId);
    if (entry.clients.size === 0) {
      this.cleanupSyncEntry(entry);
    }
  }

  private cleanupSyncEntry(entry: SyncStreamEntry): void {
    clearTimeout(entry.timeoutId);
    if (this.syncStreams.get(entry.id) === entry) {
      this.syncStreams.delete(entry.id);
    }
    entry.clients.forEach((client) => {
      if (!client.res.writableEnded) {
        client.res.end();
      }
    });
    entry.clients.clear();
    if (typeof (entry.stream as any).destroy === 'function') {
      (entry.stream as any).destroy();
    }
  }
}

type SyncClient = {
  req: IncomingMessage;
  res: ServerResponse;
  passThrough: PassThrough;
  icyEnabled: boolean;
  icyInterval?: number;
  icyName?: string;
};

type SyncStreamEntry = {
  id: string;
  zoneId: number;
  outputProfile: 'mp3';
  outputSettings: AudioOutputSettings;
  session: PlaybackSession;
  expectedCount: number;
  clients: Map<string, SyncClient>;
  stream: NodeJS.ReadableStream;
  started: boolean;
  timeoutId: NodeJS.Timeout;
};
