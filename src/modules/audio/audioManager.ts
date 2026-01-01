import { randomUUID } from 'node:crypto';
import { createLogger } from '@/core/logging/logger';
import { audioStreamEngine } from '@/modules/audio/engine/audioStreamEngine';
import type { PlaybackSource, OutputProfile } from '@/modules/audio/engine/audioSession';
export type { PlaybackSource, OutputProfile } from '@/modules/audio/engine/audioSession';
import { resolvePlaybackSource } from '@/modules/audio/utils/sourceResolver';
import { audioOutputSettings, type AudioOutputSettings, type HttpProfile } from '@/modules/audio/utils/audioFormat';
import { notifyTransportError } from '@/modules/audio/outputs/queueUpdater';

export interface PlaybackMetadata {
  title: string;
  artist: string;
  album: string;
  coverurl?: string;
  duration?: number;
  /** Optional absolute audiopath/uri (e.g. spotify:track:abc123) to preserve in queue. */
  audiopath?: string;
  /** Optional provider-specific track id (e.g. spotify track id). */
  trackId?: string;
  /** Optional playback context (e.g. spotify album/playlist URI). */
  station?: string;
  /** Optional index into the station/context (e.g. playlist position). */
  stationIndex?: number;
  /** Optional full queue of URIs for transport to use (e.g. Spotify Connect). */
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

/**
 * Central coordinator for playback commands. Every play/pause/stop request
 * funnels through the audio manager so the same stream can be re-used by
 * future transports (DLNA, AirPlay, Sendspin, ...).
 */
class AudioManager {
  private readonly log = createLogger('Audio', 'Manager');
  private readonly sessions = new Map<number, PlaybackSession>();
  private readonly zonePcmPreference = new Map<number, boolean>();
  private readonly zoneOutputOverrides = new Map<number, Partial<AudioOutputSettings>>();
  private readonly zoneProfileOverrides = new Map<number, OutputProfile>();
  private readonly zoneHttpPreferences = new Map<
    number,
    { httpProfile?: HttpProfile; icyEnabled?: boolean; icyInterval?: number; icyName?: string }
  >();

  constructor() {
    audioStreamEngine.setSessionTerminationHandler((zoneId, stats, reason) =>
      this.handleEngineTermination(zoneId, stats, reason),
    );
  }

  public startPlayback(
    zoneId: number,
    source: string,
    metadata?: PlaybackMetadata,
    requiresPcm?: boolean,
  ): PlaybackSession | null {
    if (typeof requiresPcm === 'boolean') {
      this.zonePcmPreference.set(zoneId, requiresPcm);
    }
    const playbackSource = resolvePlaybackSource(source);
    return this.startWithResolvedSource(zoneId, source, playbackSource, metadata, requiresPcm);
  }

  public startExternalPlayback(
    zoneId: number,
    label: string,
    playbackSource: PlaybackSource | null,
    metadata?: PlaybackMetadata,
    requiresPcm?: boolean,
  ): PlaybackSession | null {
    if (typeof requiresPcm === 'boolean') {
      this.zonePcmPreference.set(zoneId, requiresPcm);
    }
    return this.startWithResolvedSource(zoneId, label, playbackSource, metadata, requiresPcm);
  }

  public pausePlayback(zoneId: number): PlaybackSession | null {
    const session = this.sessions.get(zoneId);
    if (!session || session.state !== 'playing') {
      return null;
    }
    // For pipe-based sources (e.g. embedded librespot), keep the engine alive so
    // downstream transports (AirPlay/DLNA) don't thrash on quick pauses/track changes.
    if (session.playbackSource?.kind !== 'pipe') {
      audioStreamEngine.stop(zoneId, 'pause');
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
      this.log.debug('playback resumed (transport-only)', { zoneId, source: session.source });
      return session;
    }
    // If we never tore down the engine (pipe-based sources), just flip state.
    if (
      session.playbackSource.kind === 'pipe' &&
      audioStreamEngine.hasSession(zoneId)
    ) {
      session.state = 'playing';
      session.updatedAt = Date.now();
      session.startedAt = Date.now();
      this.log.debug('playback resumed (reusing pipe session)', { zoneId, source: session.source });
      return session;
    }
    const handles = this.createStreamHandles(zoneId);
    session.stream = handles.stream;
    session.pcmStream = handles.pcmStream;
    const effectiveOutput = this.getEffectiveOutputSettings(zoneId);
    const outputSignature = this.buildOutputSignature(effectiveOutput);
    const profiles = this.computeProfiles(
      session.playbackSource,
      this.zonePcmPreference.get(zoneId) ?? true,
      session.profiles,
    );
    audioStreamEngine.start(zoneId, session.playbackSource, profiles, effectiveOutput);
    session.profiles = profiles;
    session.outputSettings = outputSignature;
    session.state = 'playing';
    session.updatedAt = Date.now();
    this.log.debug('playback resumed', { zoneId, source: session.source });
    return session;
  }

  public stopPlayback(zoneId: number): PlaybackSession | null {
    const session = this.sessions.get(zoneId);
    if (!session) {
      return null;
    }
    audioStreamEngine.stop(zoneId, 'stop');
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

  private createStreamHandles(zoneId: number): { stream: AudioStreamHandle; pcmStream: AudioStreamHandle } {
    const id = `${zoneId}-${randomUUID()}`;
    const basePath = `/streams/${zoneId}/${id}`;
    const createdAt = Date.now();
    const stream: AudioStreamHandle = {
      id,
      url: `${basePath}.mp3`,
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

  private startWithResolvedSource(
    zoneId: number,
    label: string,
    playbackSource: PlaybackSource | null,
    metadata?: PlaybackMetadata,
    requiresPcm?: boolean,
  ): PlaybackSession | null {
    this.log.info('startWithResolvedSource', {
      zoneId,
      label,
      sourceKind: playbackSource?.kind ?? null,
      hasStream: playbackSource ? 'stream' in playbackSource && !!(playbackSource as any).stream : false,
    });
    const existing = this.sessions.get(zoneId);
    const effectivePcmPreference =
      typeof requiresPcm === 'boolean'
        ? requiresPcm
        : this.zonePcmPreference.get(zoneId) ?? true;
    if (typeof requiresPcm === 'boolean') {
      this.zonePcmPreference.set(zoneId, requiresPcm);
    }
    const preferredProfile = this.zoneProfileOverrides.get(zoneId);
    const profiles = this.computeProfiles(
      playbackSource,
      effectivePcmPreference,
      preferredProfile ? [preferredProfile] : undefined,
    );
    const effectiveOutput = this.getEffectiveOutputSettings(zoneId);
    const outputSignature = this.buildOutputSignature(effectiveOutput);
    const transportOnly = !playbackSource && (label.toLowerCase() === 'spotify' || label.toLowerCase() === 'musicassistant');

    // If we are already on the same source (e.g. track change on the same pipe),
    // keep the existing stream URLs and engine session running.
    if (existing && this.isSamePlaybackSource(existing.playbackSource, playbackSource)) {
      existing.source = label;
      if (playbackSource) {
        existing.playbackSource = playbackSource;
      }
      if (metadata) {
        existing.metadata = metadata;
        if (metadata.duration && metadata.duration > 0) {
          existing.duration = metadata.duration;
        }
      }
      existing.elapsed = 0;
      existing.state = 'playing';
      existing.startedAt = Date.now();
      existing.updatedAt = Date.now();
      const profilesChanged = !this.sameProfiles(existing.profiles, profiles);
      existing.profiles = profiles;
      const outputChanged =
        !existing.outputSettings ||
        existing.outputSettings.sampleRate !== outputSignature.sampleRate ||
        existing.outputSettings.channels !== outputSignature.channels ||
        existing.outputSettings.pcmBitDepth !== outputSignature.pcmBitDepth;
      // Ensure engine session exists (resume after a pause).
      if (playbackSource && (outputChanged || profilesChanged || !audioStreamEngine.hasSession(zoneId))) {
        if ((outputChanged || profilesChanged) && audioStreamEngine.hasSession(zoneId)) {
          this.log.info('restarting audio engine to apply output format', {
            zoneId,
            sampleRate: outputSignature.sampleRate,
            channels: outputSignature.channels,
            pcmBitDepth: outputSignature.pcmBitDepth,
            profiles,
          });
          audioStreamEngine.stop(zoneId, 'reconfigure');
        }
        audioStreamEngine.start(zoneId, playbackSource, profiles, effectiveOutput);
      }
      existing.outputSettings = outputSignature;
      this.log.debug('playback continued on same source', { zoneId, source: label });
      return existing;
    }

    const wantsHandoff =
      label.toLowerCase() === 'applemusic' &&
      playbackSource?.kind === 'url' &&
      Boolean(existing);
    if (!wantsHandoff) {
      audioStreamEngine.stop(zoneId, 'switch');
    }
    if (!playbackSource && !transportOnly) {
      this.log.warn('unable to resolve playback source; skipping session', {
        zoneId,
        source: label,
      });
      return null;
    }
    if (playbackSource) {
      this.log.info('starting audio engine', { zoneId, kind: playbackSource.kind, profiles, handoff: wantsHandoff });
      if (wantsHandoff) {
        audioStreamEngine.startWithHandoff(zoneId, playbackSource, profiles, effectiveOutput, {
          waitProfile: 'pcm',
          timeoutMs: 8000,
        });
      } else {
        audioStreamEngine.start(zoneId, playbackSource, profiles, effectiveOutput);
      }
    }
    const { stream, pcmStream } = this.createStreamHandles(zoneId);
    const session: PlaybackSession = {
      zoneId,
      source: label,
      metadata,
      stream,
      pcmStream,
      state: 'playing',
      elapsed: 0,
      duration: metadata?.duration ?? 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      playbackSource,
      cover: undefined,
      profiles,
      outputSettings: outputSignature,
    };
    this.sessions.set(zoneId, session);
    this.log.info(transportOnly ? 'playback started (transport-only)' : 'playback started', {
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
          };
          const prevUrl = prev as typeof nextUrl;
          return (
            prevUrl.url === nextUrl.url &&
            this.headersEqual(prevUrl.headers, nextUrl.headers) &&
            prevUrl.decryptionKey === nextUrl.decryptionKey &&
            prevUrl.inputFormat === nextUrl.inputFormat &&
            prevUrl.tlsVerifyHost === nextUrl.tlsVerifyHost
          );
        }
      case 'file':
        return prev.path === (next as { kind: 'file'; path: string }).path;
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
    if (reason) {
      this.log.debug('suppressing transport error; engine stopped intentionally', {
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
        notifyTransportError(zoneId, `${session.source} stream failed: ${detail}`);
      }
    }
    // Attempt to restart once for pipe sources to recover from transient ffmpeg exits.
    if (session.playbackSource?.kind === 'pipe') {
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
    return audioStreamEngine.getSessionStats(zoneId);
  }
}

export const audioManager = new AudioManager();
