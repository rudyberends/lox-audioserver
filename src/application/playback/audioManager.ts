import { randomUUID } from 'node:crypto';
import type { PassThrough } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import type {
  EngineInputSpec,
  EngineOutputSpec,
  EngineStartOptions,
  PlaybackSource,
  OutputProfile,
} from '@/ports/EngineTypes';
export type { PlaybackSource, OutputProfile } from '@/ports/EngineTypes';
import { resolvePlaybackSource } from '@/application/playback/sourceResolver';
import { decodeAudiopath } from '@/domain/loxone/audiopath';
import { audioOutputSettings, type AudioOutputSettings, type HttpProfile } from '@/ports/types/audioFormat';
import type { PlaybackService } from '@/application/playback/PlaybackService';

export interface PlaybackMetadata {
  title: string;
  artist: string;
  album: string;
  coverurl?: string;
  duration?: number;
  isRadio?: boolean;
  /** Optional absolute audiopath/uri (e.g. spotify:track:abc123) to preserve in queue. */
  audiopath?: string;
  /** Optional provider-specific track id (e.g. spotify track id). */
  trackId?: string;
  /** Optional playback context (e.g. spotify album/playlist URI). */
  station?: string;
  /** Optional index into the station/context (e.g. playlist position). */
  stationIndex?: number;
  /** Optional full queue of URIs for output/controller to use (e.g. Spotify Connect). */
  queue?: string[];
  /** Optional index within the provided queue. */
  queueIndex?: number;
}

export interface AudioStreamHandle {
  id: string;
  url: string;
  coverUrl: string;
  createdAt: number;
}

export interface CoverArtPayload {
  data: Buffer;
  mime: string;
}

export interface PlaybackSession {
  zoneId: number;
  source: string;
  metadata?: PlaybackMetadata;
  stream: AudioStreamHandle;
  pcmStream?: AudioStreamHandle;
  state: 'playing' | 'paused' | 'stopped';
  elapsed: number;
  duration: number;
  startedAt: number;
  updatedAt: number;
  playbackSource: PlaybackSource | null;
  cover?: CoverArtPayload;
  profiles?: OutputProfile[];
  outputSettings?: Pick<AudioOutputSettings, 'sampleRate' | 'channels' | 'pcmBitDepth'>;
}

type OutputState = {
  status?: 'playing' | 'paused' | 'stopped';
  position?: number;
  duration?: number;
  uri?: string;
};

type OutputNotifier = {
  notifyOutputError: (zoneId: number, reason?: string) => void;
  notifyOutputState: (zoneId: number, state: OutputState) => void;
};

/**
 * Central coordinator for playback commands. Every play/pause/stop request
 * funnels through the audio manager so the same stream can be re-used by
 * future outputs (DLNA, AirPlay, Sendspin, ...).
 */
export class AudioManager {
  private readonly log = createLogger('Audio', 'Manager');
  private readonly sessions = new Map<number, PlaybackSession>();
  private readonly zonePcmPreference = new Map<number, boolean>();
  private readonly zoneOutputOverrides = new Map<number, Partial<AudioOutputSettings>>();
  private readonly zoneProfileOverrides = new Map<number, OutputProfile>();
  private readonly zoneInputPreferences = new Map<number, { fileRealTime?: boolean }>();
  private readonly zoneHttpPreferences = new Map<
    number,
    { httpProfile?: HttpProfile; icyEnabled?: boolean; icyInterval?: number; icyName?: string }
  >();
  private readonly playbackService: PlaybackService;
  private readonly outputNotifier: OutputNotifier;

  constructor(playbackService: PlaybackService, outputNotifier: OutputNotifier) {
    this.playbackService = playbackService;
    this.outputNotifier = outputNotifier;
    this.playbackService.setSessionTerminationHandler((zoneId, stats, reason) =>
      this.handleEngineTermination(zoneId, stats, reason),
    );
  }

  private decorateRadioSource(
    zoneId: number,
    source: PlaybackSource | null,
    metadata?: PlaybackMetadata,
    rawSource?: string,
  ): PlaybackSource | null {
    if (!source || source.kind !== 'url' || !metadata?.isRadio) {
      return source;
    }
    const headers: Record<string, string> = { ...(source.headers ?? {}) };
    headers['Icy-MetaData'] = '1';
    if (this.isProxyUrl(source.url)) {
      headers['X-Loxone-Zone'] = String(zoneId);
    }
    const realTime = this.shouldUseRealTime(rawSource ?? source.url);
    return { ...source, headers, ...(realTime ? { realTime: true } : {}) };
  }

  private normalizeStartAtSec(startAtSec?: number): number | null {
    if (!Number.isFinite(startAtSec)) {
      return null;
    }
    const safe = Math.max(0, startAtSec ?? 0);
    return safe > 0 ? safe : null;
  }

  private applyStartAt(
    source: PlaybackSource | null,
    startAtSec?: number | null,
    metadata?: PlaybackMetadata,
  ): PlaybackSource | null {
    if (!source || !startAtSec || startAtSec <= 0) {
      return source;
    }
    if (metadata?.isRadio) {
      return source;
    }
    if (source.kind === 'pipe') {
      return source;
    }
    return { ...source, startAtSec };
  }

  private getStartAtSec(source: PlaybackSource | null): number {
    if (!source || source.kind === 'pipe') {
      return 0;
    }
    const startAtSec = (source as { startAtSec?: number }).startAtSec;
    if (!Number.isFinite(startAtSec)) {
      return 0;
    }
    return Math.max(0, startAtSec ?? 0);
  }

  private isProxyUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.pathname === '/streams/proxy';
    } catch {
      return false;
    }
  }

  private shouldUseRealTime(rawSource?: string): boolean {
    if (!rawSource) {
      return false;
    }
    const rawLower = rawSource.toLowerCase();
    if (rawLower.startsWith('tunein:') || rawLower.startsWith('radio:') || rawLower.includes('tunein')) {
      return true;
    }
    const decoded = decodeAudiopath(rawSource);
    const decodedLower = (decoded || '').toLowerCase();
    return decodedLower.startsWith('tunein:') || decodedLower.startsWith('radio:') || decodedLower.includes('tunein');
  }

  public startPlayback(
    zoneId: number,
    source: string,
    metadata?: PlaybackMetadata,
    requiresPcm?: boolean,
    options?: { startAtSec?: number },
  ): PlaybackSession | null {
    if (typeof requiresPcm === 'boolean') {
      this.zonePcmPreference.set(zoneId, requiresPcm);
    }
    const startAtSec = this.normalizeStartAtSec(options?.startAtSec);
    const playbackSource = this.decorateRadioSource(
      zoneId,
      resolvePlaybackSource(source),
      metadata,
      source,
    );
    const effectiveSource = this.applyStartAt(playbackSource, startAtSec, metadata);
    return this.startWithResolvedSource(zoneId, source, effectiveSource, metadata, requiresPcm);
  }

  public startExternalPlayback(
    zoneId: number,
    label: string,
    playbackSource: PlaybackSource | null,
    metadata?: PlaybackMetadata,
    requiresPcm?: boolean,
    options?: { startAtSec?: number },
  ): PlaybackSession | null {
    if (typeof requiresPcm === 'boolean') {
      this.zonePcmPreference.set(zoneId, requiresPcm);
    }
    const startAtSec = this.normalizeStartAtSec(options?.startAtSec);
    const rawSource = playbackSource?.kind === 'url' ? playbackSource.url : undefined;
    const decorated = this.decorateRadioSource(zoneId, playbackSource, metadata, rawSource);
    const effectiveSource = this.applyStartAt(decorated, startAtSec, metadata);
    return this.startWithResolvedSource(zoneId, label, effectiveSource, metadata, requiresPcm);
  }

  public pausePlayback(zoneId: number): PlaybackSession | null {
    const session = this.sessions.get(zoneId);
    if (!session || session.state !== 'playing') {
      return null;
    }
    // Keep the engine alive on pause so outputs can resume instantly.
    // Backpressure from zero subscribers will stall ffmpeg output safely.
    if (session.startedAt) {
      session.elapsed = Math.max(0, Math.round((Date.now() - session.startedAt) / 1000));
    }
    session.state = 'paused';
    session.updatedAt = Date.now();
    this.log.debug('playback paused', { zoneId, source: session.source });
    return session;
  }

  public resumePlayback(zoneId: number): PlaybackSession | null {
    const session = this.sessions.get(zoneId);
    if (!session) {
      return null;
    }
    if (session.state === 'playing') {
      this.log.debug('resume ignored; already playing', { zoneId });
      return session;
    }
    if (!session.playbackSource) {
      session.state = 'playing';
      session.updatedAt = Date.now();
      session.startedAt = Date.now();
      this.log.debug('playback resumed (output-only)', { zoneId, source: session.source });
      return session;
    }
    // If we never tore down the engine, just flip state.
    if (this.playbackService.hasSession(zoneId)) {
      session.state = 'playing';
      session.updatedAt = Date.now();
      session.startedAt = Date.now() - (session.elapsed ?? 0) * 1000;
      this.log.debug('playback resumed (reusing engine session)', { zoneId, source: session.source });
      return session;
    }
    const rawElapsed = Number.isFinite(session.elapsed) ? Math.max(0, session.elapsed) : 0;
    const duration = session.duration ?? session.metadata?.duration ?? 0;
    const boundedElapsed =
      duration > 0 ? Math.min(rawElapsed, Math.max(0, duration - 1)) : rawElapsed;
    const resumeAtSec = this.normalizeStartAtSec(boundedElapsed);
    const effectiveSource =
      this.applyStartAt(session.playbackSource, resumeAtSec, session.metadata) ??
      session.playbackSource;
    const profiles = this.computeProfiles(
      effectiveSource,
      this.zonePcmPreference.get(zoneId) ?? true,
      session.profiles,
    );
    const streamProfile = profiles.includes('aac') ? 'aac' : 'mp3';
    const handles = this.createStreamHandles(zoneId, streamProfile);
    session.stream = handles.stream;
    session.pcmStream = handles.pcmStream;
    const effectiveOutput = this.getEffectiveOutputSettings(zoneId);
    const outputSignature = this.buildOutputSignature(effectiveOutput);
    const startOptions = this.buildEngineStartOptions(zoneId, effectiveSource, profiles, effectiveOutput);
    this.playbackService.start(startOptions);
    session.playbackSource = effectiveSource;
    session.profiles = profiles;
    session.outputSettings = outputSignature;
    session.state = 'playing';
    session.updatedAt = Date.now();
    session.startedAt =
      resumeAtSec && resumeAtSec > 0 ? Date.now() - resumeAtSec * 1000 : Date.now();
    session.elapsed = boundedElapsed;
    this.log.debug('playback resumed', { zoneId, source: session.source });
    return session;
  }

  public stopPlayback(zoneId: number): PlaybackSession | null {
    const session = this.sessions.get(zoneId);
    if (!session) {
      return null;
    }
    this.playbackService.stop(zoneId, 'stop', { discardSubscribers: true });
    this.sessions.delete(zoneId);
    this.log.debug('playback stopped', { zoneId, source: session.source });
    return session;
  }

  public getStreamHandle(zoneId: number): AudioStreamHandle | null {
    return this.sessions.get(zoneId)?.stream ?? null;
  }

  public getSession(zoneId: number): PlaybackSession | null {
    return this.sessions.get(zoneId) ?? null;
  }

  public updateSessionCover(zoneId: number, cover?: CoverArtPayload): string | undefined {
    const session = this.sessions.get(zoneId);
    if (!session) {
      return undefined;
    }
    session.cover = cover;
    session.updatedAt = Date.now();
    return cover ? session.stream.coverUrl : undefined;
  }

  public updateSessionTiming(zoneId: number, elapsed: number, duration: number): void {
    const session = this.sessions.get(zoneId);
    if (!session) {
      return;
    }
    const safeElapsed = Math.max(0, elapsed);
    const safeDuration = Math.max(0, duration);
    if (session.elapsed === safeElapsed && session.duration === safeDuration) {
      return;
    }
    session.elapsed = safeElapsed;
    session.duration = safeDuration;
    if (session.metadata) {
      session.metadata.duration = safeDuration;
    }
    session.updatedAt = Date.now();
  }

  public getOutputSettings(zoneId: number): Pick<AudioOutputSettings, 'sampleRate' | 'channels' | 'pcmBitDepth'> | null {
    return this.sessions.get(zoneId)?.outputSettings ?? null;
  }

  public updateSessionMetadata(zoneId: number, metadata: PlaybackMetadata): PlaybackSession | null {
    const session = this.sessions.get(zoneId);
    if (!session) {
      return null;
    }
    session.metadata = metadata;
    if (metadata.duration && metadata.duration > 0) {
      session.duration = metadata.duration;
    }
    session.updatedAt = Date.now();
    return session;
  }

  public waitForFirstChunk(
    zoneId: number,
    profile: OutputProfile = 'mp3',
    timeoutMs = 2000,
  ): Promise<boolean> {
    return this.playbackService.waitForFirstChunk(zoneId, profile, timeoutMs);
  }

  public createStream(
    zoneId: number,
    profile: OutputProfile = 'mp3',
    options?: { primeWithBuffer?: boolean; label?: string },
  ): PassThrough | null {
    return this.playbackService.createStream(zoneId, profile, options);
  }

  public createLocalPcmTap(
    zoneId: number,
    source: PlaybackSource,
    options?: {
      outputSettings?: Pick<AudioOutputSettings, 'sampleRate' | 'channels' | 'pcmBitDepth'>;
      startAtSec?: number;
      label?: string;
    },
  ): { stream: PassThrough; stop: () => void } | null {
    const base = this.getEffectiveOutputSettings(zoneId);
    const outputSettings: AudioOutputSettings = {
      ...base,
      sampleRate: options?.outputSettings?.sampleRate ?? base.sampleRate,
      channels: options?.outputSettings?.channels ?? base.channels,
      pcmBitDepth: options?.outputSettings?.pcmBitDepth ?? base.pcmBitDepth,
    };
    const playbackSource =
      Number.isFinite(options?.startAtSec) && (options?.startAtSec ?? 0) > 0
        ? { ...source, startAtSec: options?.startAtSec }
        : source;
    const local = this.playbackService.createLocalSession(
      zoneId,
      playbackSource,
      'pcm',
      outputSettings,
      () => {
        /* no-op */
      },
    );
    local.start();
    const stream = local.createSubscriber({
      primeWithBuffer: false,
      label: options?.label ?? `local-${zoneId}`,
    });
    if (!stream) {
      local.stop();
      return null;
    }
    const stop = (): void => {
      local.stop();
      stream.destroy();
    };
    return { stream, stop };
  }

  private createStreamHandles(
    zoneId: number,
    streamProfile: OutputProfile = 'mp3',
  ): { stream: AudioStreamHandle; pcmStream: AudioStreamHandle } {
    const id = `${zoneId}-${randomUUID()}`;
    const basePath = `/streams/${zoneId}/${id}`;
    const createdAt = Date.now();
    const streamExt = streamProfile === 'aac' ? 'aac' : 'mp3';
    const stream: AudioStreamHandle = {
      id,
      url: `${basePath}.${streamExt}`,
      coverUrl: `${basePath}/cover`,
      createdAt,
    };
    const pcmStream: AudioStreamHandle = {
      ...stream,
      url: `${basePath}.wav`,
    };
    return { stream, pcmStream };
  }

  private buildOutputSignature(settings: AudioOutputSettings): Pick<
    AudioOutputSettings,
    'sampleRate' | 'channels' | 'pcmBitDepth'
  > {
    return {
      sampleRate: settings.sampleRate,
      channels: settings.channels,
      pcmBitDepth: settings.pcmBitDepth,
    };
  }

  private toEngineInputSpec(source: PlaybackSource): EngineInputSpec {
    switch (source.kind) {
      case 'url':
        return {
          kind: 'url',
          url: source.url,
          headers: source.headers,
          decryptionKey: source.decryptionKey,
          tlsVerifyHost: source.tlsVerifyHost,
          inputFormat: source.inputFormat,
          logLevel: source.logLevel,
          startAtSec: source.startAtSec,
          realTime: source.realTime,
          lowLatency: source.lowLatency,
          restartOnFailure: source.restartOnFailure,
        };
      case 'pipe':
        return {
          kind: 'pipe',
          path: source.path,
          format: source.format,
          sampleRate: source.sampleRate,
          channels: source.channels,
          realTime: source.realTime,
          stream: source.stream,
        };
      case 'file':
        return {
          kind: 'file',
          path: source.path,
          loop: source.loop,
          padTailSec: source.padTailSec,
          preDelayMs: source.preDelayMs,
          startAtSec: source.startAtSec,
          realTime: source.realTime,
        };
      default:
        throw new Error('Unknown PlaybackSource.');
    }
  }

  private buildEngineOutputSpecs(
    profiles: OutputProfile[],
    outputSettings: AudioOutputSettings,
  ): EngineOutputSpec[] {
    return profiles.map((profile) => ({
      profile,
      sampleRate: outputSettings.sampleRate,
      channels: outputSettings.channels,
      pcmBitDepth: outputSettings.pcmBitDepth,
      prebufferBytes: outputSettings.prebufferBytes,
    }));
  }

  private buildEngineStartOptions(
    zoneId: number,
    playbackSource: PlaybackSource,
    profiles: OutputProfile[],
    outputSettings: AudioOutputSettings,
    handoff?: EngineStartOptions['handoff'],
  ): EngineStartOptions {
    const options: EngineStartOptions = {
      zoneId,
      input: this.toEngineInputSpec(playbackSource),
      outputs: this.buildEngineOutputSpecs(profiles, outputSettings),
    };
    if (typeof handoff !== 'undefined') {
      options.handoff = handoff;
    }
    return options;
  }

  private startWithResolvedSource(
    zoneId: number,
    label: string,
    playbackSource: PlaybackSource | null,
    metadata?: PlaybackMetadata,
    requiresPcm?: boolean,
  ): PlaybackSession | null {
    let effectiveSource =
      playbackSource?.kind === 'url' && metadata?.isRadio
        ? { ...playbackSource, restartOnFailure: true }
        : playbackSource;
    const inputPrefs = this.zoneInputPreferences.get(zoneId);
    if (inputPrefs?.fileRealTime === false && effectiveSource?.kind === 'file') {
      effectiveSource = { ...effectiveSource, realTime: false };
    }
    this.log.info('startWithResolvedSource', {
      zoneId,
      label,
      sourceKind: effectiveSource?.kind ?? null,
      hasStream: effectiveSource ? 'stream' in effectiveSource && !!(effectiveSource as any).stream : false,
    });
    const existing = this.sessions.get(zoneId);
    const startAtSec = this.getStartAtSec(effectiveSource);
    const effectivePcmPreference =
      typeof requiresPcm === 'boolean'
        ? requiresPcm
        : this.zonePcmPreference.get(zoneId) ?? true;
    if (typeof requiresPcm === 'boolean') {
      this.zonePcmPreference.set(zoneId, requiresPcm);
    }
    const preferredProfile = this.zoneProfileOverrides.get(zoneId);
    const profiles = this.computeProfiles(
      effectiveSource,
      effectivePcmPreference,
      preferredProfile ? [preferredProfile] : undefined,
    );
    const effectiveOutput = this.getEffectiveOutputSettings(zoneId);
    const outputSignature = this.buildOutputSignature(effectiveOutput);
    const outputOnly =
      !effectiveSource && (label.toLowerCase() === 'spotify' || label.toLowerCase() === 'musicassistant');

    // If we are already on the same source (e.g. track change on the same pipe),
    // keep the existing stream URLs and engine session running.
    if (existing && this.isSamePlaybackSource(existing.playbackSource, effectiveSource)) {
      existing.source = label;
      if (effectiveSource) {
        existing.playbackSource = effectiveSource;
      }
      if (metadata) {
        existing.metadata = metadata;
        if (metadata.duration && metadata.duration > 0) {
          existing.duration = metadata.duration;
        }
      }
      existing.elapsed = startAtSec;
      existing.state = 'playing';
      existing.startedAt = Date.now() - startAtSec * 1000;
      existing.updatedAt = Date.now();
      const profilesChanged = !this.sameProfiles(existing.profiles, profiles);
      existing.profiles = profiles;
      const outputChanged =
        !existing.outputSettings ||
        existing.outputSettings.sampleRate !== outputSignature.sampleRate ||
        existing.outputSettings.channels !== outputSignature.channels ||
        existing.outputSettings.pcmBitDepth !== outputSignature.pcmBitDepth;
      // Ensure engine session exists (resume after a pause).
      if (effectiveSource && (outputChanged || profilesChanged || !this.playbackService.hasSession(zoneId))) {
        if ((outputChanged || profilesChanged) && this.playbackService.hasSession(zoneId)) {
          this.log.info('restarting audio engine to apply output format', {
            zoneId,
            sampleRate: outputSignature.sampleRate,
            channels: outputSignature.channels,
            pcmBitDepth: outputSignature.pcmBitDepth,
            profiles,
          });
          this.playbackService.stop(zoneId, 'reconfigure', { discardSubscribers: true });
        }
        const startOptions = this.buildEngineStartOptions(zoneId, effectiveSource, profiles, effectiveOutput);
        this.playbackService.start(startOptions);
      }
      existing.outputSettings = outputSignature;
      this.log.debug('playback continued on same source', { zoneId, source: label });
      return existing;
    }

    const isAppleMusic = label.toLowerCase() === 'applemusic';
    const wantsHandoff =
      isAppleMusic &&
      effectiveSource?.kind === 'url' &&
      Boolean(existing);
    if (!wantsHandoff) {
      this.playbackService.stop(zoneId, 'switch', { discardSubscribers: true });
    }
    if (!effectiveSource && !outputOnly) {
      this.log.warn('unable to resolve playback source; skipping session', {
        zoneId,
        source: label,
      });
      return null;
    }
    if (effectiveSource) {
      this.log.info('starting audio engine', { zoneId, kind: effectiveSource.kind, profiles, handoff: wantsHandoff });
      if (wantsHandoff) {
        const startOptions = this.buildEngineStartOptions(zoneId, effectiveSource, profiles, effectiveOutput, {
          waitProfile: 'pcm',
          timeoutMs: isAppleMusic ? 15000 : 8000,
        });
        this.playbackService.startWithHandoff(startOptions);
      } else {
        const startOptions = this.buildEngineStartOptions(zoneId, effectiveSource, profiles, effectiveOutput);
        this.playbackService.start(startOptions);
      }
    }
    const streamProfile = profiles.includes('aac') ? 'aac' : 'mp3';
    const { stream, pcmStream } = this.createStreamHandles(zoneId, streamProfile);
    const session: PlaybackSession = {
      zoneId,
      source: label,
      metadata,
      stream,
      pcmStream,
      state: 'playing',
      elapsed: startAtSec,
      duration: metadata?.duration ?? 0,
      startedAt: Date.now() - startAtSec * 1000,
      updatedAt: Date.now(),
      playbackSource: effectiveSource,
      cover: undefined,
      profiles,
      outputSettings: outputSignature,
    };
    this.sessions.set(zoneId, session);
    this.log.info(outputOnly ? 'playback started (output-only)' : 'playback started', {
      zoneId,
      source: label,
      stream: stream.id,
      title: metadata?.title,
    });
    return session;
  }

  private isSamePlaybackSource(
    prev?: PlaybackSource | null,
    next?: PlaybackSource | null,
  ): boolean {
    if (!prev || !next) return false;
    if (prev.kind !== next.kind) return false;
    switch (prev.kind) {
      case 'pipe':
        {
          const prevPipe = prev as typeof prev & { stream?: NodeJS.ReadableStream };
          const nextPipe = next as typeof prev & { stream?: NodeJS.ReadableStream };
          if (prevPipe.stream || nextPipe.stream) {
            if (prevPipe.stream !== nextPipe.stream) {
              return false;
            }
          }
          return (
            prev.path === nextPipe.path &&
            prev.format === nextPipe.format &&
            prev.sampleRate === nextPipe.sampleRate &&
            prev.channels === nextPipe.channels
          );
        }
      case 'url':
        {
          const nextUrl = next as {
            kind: 'url';
            url: string;
            headers?: Record<string, string>;
            decryptionKey?: string;
            inputFormat?: string;
            tlsVerifyHost?: string;
            startAtSec?: number;
          };
          const prevUrl = prev as typeof nextUrl;
          return (
            prevUrl.url === nextUrl.url &&
            this.headersEqual(prevUrl.headers, nextUrl.headers) &&
            prevUrl.decryptionKey === nextUrl.decryptionKey &&
            prevUrl.inputFormat === nextUrl.inputFormat &&
            prevUrl.tlsVerifyHost === nextUrl.tlsVerifyHost &&
            this.getStartAtSec(prev) === this.getStartAtSec(next)
          );
        }
      case 'file':
        {
          const nextFile = next as { kind: 'file'; path: string; realTime?: boolean; startAtSec?: number };
          const prevPace = (prev as { realTime?: boolean }).realTime !== false;
          const nextPace = nextFile.realTime !== false;
          return (
            prev.path === nextFile.path &&
            prevPace === nextPace &&
            this.getStartAtSec(prev) === this.getStartAtSec(next)
          );
        }
      default:
        return false;
    }
  }

  private headersEqual(
    left?: Record<string, string>,
    right?: Record<string, string>,
  ): boolean {
    if (!left && !right) return true;
    if (!left || !right) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    leftKeys.sort();
    rightKeys.sort();
    for (let i = 0; i < leftKeys.length; i += 1) {
      if (leftKeys[i] !== rightKeys[i]) return false;
      if (left[leftKeys[i]] !== right[rightKeys[i]]) return false;
    }
    return true;
  }

  private sameProfiles(a?: OutputProfile[] | null, b?: OutputProfile[] | null): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((p, idx) => p === sortedB[idx]);
  }

  private handleEngineTermination(
    zoneId: number,
    stats: {
      profile: OutputProfile;
      bps: number | null;
      bufferedBytes: number;
      totalBytes: number;
      lastUpdated: number | null;
      subscribers: number;
      restarts: number;
      lastError: string | null;
      lastErrorAt: number | null;
      lastStderr: string | null;
      lastStderrAt: number | null;
      lastExitCode: number | null;
      lastExitSignal: string | null;
      lastExitAt: number | null;
      subscriberDrops: number;
      lastSubscriberDropAt: number | null;
    } | null,
    reason?: string,
  ): void {
    const session = this.sessions.get(zoneId);
    if (!session) return;
    const duration = session.duration ?? session.metadata?.duration ?? 0;
    const elapsedFromClock = session.startedAt
      ? Math.round(Math.max(0, Date.now() - session.startedAt) / 1000)
      : session.elapsed;
    const observedElapsed = Math.max(session.elapsed ?? 0, elapsedFromClock);
    const shouldEmitEnded =
      !reason &&
      session.state === 'playing' &&
      duration > 0 &&
      !session.metadata?.isRadio &&
      observedElapsed >= Math.max(0, duration - 1);
    if (reason === 'pause') {
      this.log.debug('engine stopped for pause; keeping session', {
        zoneId,
        source: session.source,
      });
      return;
    }
    this.sessions.delete(zoneId);
    this.log.warn('playback session terminated by engine', {
      zoneId,
      source: session.source,
    });
    if (shouldEmitEnded) {
      this.outputNotifier.notifyOutputState(zoneId, {
        status: 'stopped',
        position: duration,
        duration,
        uri: session.metadata?.audiopath,
      });
    }
    if (reason) {
      this.log.debug('suppressing output error; engine stopped intentionally', {
        zoneId,
        source: session.source,
        reason,
      });
      return;
    }
    if (session.state === 'playing') {
      const exitCode = stats?.lastExitCode;
      const exitSignal = stats?.lastExitSignal;
      const stderr = stats?.lastStderr?.trim();
      if (exitCode !== 0 || exitSignal || stderr) {
        const detail =
          stderr ||
          (typeof exitCode === 'number' ? `ffmpeg exited (${exitCode})` : exitSignal ? `ffmpeg exited (${exitSignal})` : 'ffmpeg exited');
        this.outputNotifier.notifyOutputError(zoneId, `${session.source} stream failed: ${detail}`);
      }
    }
    // Attempt to restart once for pipe sources to recover from transient ffmpeg exits.
    if (session.playbackSource?.kind === 'pipe') {
      const pipeStream = (session.playbackSource as { stream?: NodeJS.ReadableStream }).stream;
      const streamEnded = Boolean(
        pipeStream &&
          ((pipeStream as { readableEnded?: boolean }).readableEnded ||
            (pipeStream as { destroyed?: boolean }).destroyed),
      );
      if (streamEnded) {
        this.log.info('pipe source ended; skipping restart', { zoneId, source: session.source });
        return;
      }
      setTimeout(() => {
        this.startWithResolvedSource(
          zoneId,
          session.source,
          session.playbackSource,
          session.metadata,
          this.zonePcmPreference.get(zoneId),
        );
      }, 250);
    }
  }

  private computeProfiles(
    playbackSource: PlaybackSource | null,
    requiresPcm: boolean,
    preferred?: OutputProfile[],
  ): OutputProfile[] {
    if (preferred?.length) {
      return preferred;
    }
    if (!playbackSource || playbackSource.kind !== 'pipe') {
      if (requiresPcm) {
        return ['pcm'];
      }
      return ['mp3'];
    }
    return requiresPcm ? (['pcm'] as Array<'pcm'>) : (['mp3'] as Array<'mp3'>);
  }

  public setPreferredOutputSettings(
    zoneId: number,
    override: (Partial<AudioOutputSettings> & { profile?: OutputProfile }) | null,
  ): void {
    if (!override || Object.keys(override).length === 0) {
      this.zoneOutputOverrides.delete(zoneId);
      this.zoneProfileOverrides.delete(zoneId);
      return;
    }
    this.zoneOutputOverrides.set(zoneId, override);
    if (override.profile) {
      this.zoneProfileOverrides.set(zoneId, override.profile);
    }
  }

  public setInputPreferences(zoneId: number, prefs: { fileRealTime?: boolean } | null): void {
    if (!prefs || Object.keys(prefs).length === 0) {
      this.zoneInputPreferences.delete(zoneId);
      return;
    }
    this.zoneInputPreferences.set(zoneId, prefs);
  }

  public getEffectiveOutputSettings(zoneId: number): AudioOutputSettings {
    const outputOverride = this.zoneOutputOverrides.get(zoneId);
    if (outputOverride && Object.keys(outputOverride).length > 0) {
      const { profile: _ignoredProfile, ...rest } = outputOverride as any;
      return { ...audioOutputSettings, ...(rest as Partial<AudioOutputSettings>) };
    }
    return audioOutputSettings;
  }

  public setHttpPreferences(
    zoneId: number,
    prefs: { httpProfile?: HttpProfile; icyEnabled?: boolean; icyInterval?: number; icyName?: string } | null,
  ): void {
    if (!prefs || Object.keys(prefs).length === 0) {
      this.zoneHttpPreferences.delete(zoneId);
      return;
    }
    this.zoneHttpPreferences.set(zoneId, prefs);
  }

  public getHttpPreferences(
    zoneId: number,
  ): { httpProfile?: HttpProfile; icyEnabled?: boolean; icyInterval?: number; icyName?: string } | undefined {
    return this.zoneHttpPreferences.get(zoneId);
  }

  public getStreamStats(
    zoneId: number,
  ): Array<{
    profile: OutputProfile;
    bps: number | null;
    bufferedBytes: number;
    totalBytes: number;
    lastUpdated: number | null;
    subscribers: number;
    restarts: number;
    lastError: string | null;
    lastErrorAt: number | null;
    lastStderr: string | null;
    lastStderrAt: number | null;
    lastExitCode: number | null;
    lastExitSignal: string | null;
    lastExitAt: number | null;
    subscriberDrops: number;
    lastSubscriberDropAt: number | null;
  }> {
    return this.playbackService.getSessionStats(zoneId);
  }
}
