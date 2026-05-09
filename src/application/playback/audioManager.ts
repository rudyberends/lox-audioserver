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
import type { AudioOutputSettings } from '@/ports/types/audioFormat';
import type { PlaybackService } from '@/application/playback/PlaybackService';
import type { ZoneAudioPreferences } from '@/application/playback/ZoneAudioPreferences';

import type {
  PlaybackMetadata,
  AudioStreamHandle,
  CoverArtPayload,
  PlaybackSession,
} from '@/ports/types/playback';
export type {
  PlaybackMetadata,
  AudioStreamHandle,
  CoverArtPayload,
  PlaybackSession,
} from '@/ports/types/playback';

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
  private readonly equalizerRestartTimers = new Map<number, NodeJS.Timeout>();
  private static readonly EQUALIZER_RESTART_DEBOUNCE_MS = 350;
  private readonly playRequestTimes = new Map<number, { requestedAt: number; uri?: string; type?: string }>();
  private readonly playRequestMaxAgeMs = 60_000;
  private readonly playbackService: PlaybackService;
  private readonly outputNotifier: OutputNotifier;
  private readonly prefs: ZoneAudioPreferences;

  constructor(
    playbackService: PlaybackService,
    outputNotifier: OutputNotifier,
    prefs: ZoneAudioPreferences,
  ) {
    this.playbackService = playbackService;
    this.outputNotifier = outputNotifier;
    this.prefs = prefs;
    this.playbackService.setSessionTerminationHandler((zoneId, stats, reason) =>
      this.handleEngineTermination(zoneId, stats, reason),
    );
  }

  public markPlayRequest(zoneId: number, details?: { uri?: string; type?: string }): void {
    this.playRequestTimes.set(zoneId, {
      requestedAt: Date.now(),
      uri: details?.uri,
      type: details?.type,
    });
  }

  public clearPlayRequest(zoneId: number): void {
    this.playRequestTimes.delete(zoneId);
  }

  private peekPlayRequest(zoneId: number): { requestedAt: number; uri?: string; type?: string } | null {
    const entry = this.playRequestTimes.get(zoneId);
    if (!entry) {
      return null;
    }
    if (Date.now() - entry.requestedAt > this.playRequestMaxAgeMs) {
      return null;
    }
    return entry;
  }

  private claimPlayRequest(zoneId: number): { requestedAt: number; uri?: string; type?: string } | null {
    const entry = this.playRequestTimes.get(zoneId);
    if (!entry) {
      return null;
    }
    this.playRequestTimes.delete(zoneId);
    if (Date.now() - entry.requestedAt > this.playRequestMaxAgeMs) {
      return null;
    }
    return entry;
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

  private applyZonePlaybackPreDelay(zoneId: number, source: PlaybackSource | null): PlaybackSource | null {
    if (!source) {
      return source;
    }
    const zoneDelay = this.prefs.getPlaybackPreDelayMs(zoneId);
    if (!Number.isFinite(zoneDelay) || (zoneDelay ?? 0) <= 0) {
      return source;
    }
    const normalizedZoneDelay = Math.max(0, Math.round(zoneDelay ?? 0));
    try {
      if (this.prefs.getPowerStateResolver()?.(zoneId) === true) {
        return source;
      }
    } catch {
      // Ignore resolver failures and keep safe fallback behavior.
    }
    const sourceDelay = Number.isFinite(source.preDelayMs) ? Math.max(0, Math.round(source.preDelayMs ?? 0)) : 0;
    const effectiveDelay = Math.max(sourceDelay, normalizedZoneDelay);
    if (effectiveDelay <= 0 || sourceDelay === effectiveDelay) {
      return source;
    }
    return { ...source, preDelayMs: effectiveDelay };
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
    if (
      rawLower.startsWith('tunein:') ||
      rawLower.startsWith('radio:') ||
      rawLower.includes('tunein') ||
      rawLower.includes('radioparadise')
    ) {
      return true;
    }
    const decoded = decodeAudiopath(rawSource);
    const decodedLower = (decoded || '').toLowerCase();
    return (
      decodedLower.startsWith('tunein:') ||
      decodedLower.startsWith('radio:') ||
      decodedLower.includes('tunein') ||
      decodedLower.includes('radioparadise')
    );
  }

  public startPlayback(
    zoneId: number,
    source: string,
    metadata?: PlaybackMetadata,
    requiresPcm?: boolean,
    options?: { startAtSec?: number },
  ): PlaybackSession | null {
    if (typeof requiresPcm === 'boolean') {
      this.prefs.setPcmPreference(zoneId, requiresPcm);
    }
    const startAtSec = this.normalizeStartAtSec(options?.startAtSec);
    const playbackSource = this.decorateRadioSource(
      zoneId,
      resolvePlaybackSource(source),
      metadata,
      source,
    );
    const effectiveSource = this.applyStartAt(playbackSource, startAtSec, metadata);
    return this.startWithResolvedSource(
      zoneId,
      source,
      this.applyZonePlaybackPreDelay(zoneId, effectiveSource),
      metadata,
      requiresPcm,
    );
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
      this.prefs.setPcmPreference(zoneId, requiresPcm);
    }
    const startAtSec = this.normalizeStartAtSec(options?.startAtSec);
    const rawSource = playbackSource?.kind === 'url' ? playbackSource.url : undefined;
    const decorated = this.decorateRadioSource(zoneId, playbackSource, metadata, rawSource);
    const effectiveSource = this.applyStartAt(decorated, startAtSec, metadata);
    return this.startWithResolvedSource(
      zoneId,
      label,
      this.applyZonePlaybackPreDelay(zoneId, effectiveSource),
      metadata,
      requiresPcm,
    );
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
      this.prefs.getPcmPreference(zoneId) ?? true,
      session.profiles,
    );
    const streamProfile = profiles.includes('flac') ? 'flac' : profiles.includes('aac') ? 'aac' : profiles.includes('mp3') ? 'mp3' : 'pcm';
    const handles = this.createStreamHandles(zoneId, streamProfile);
    session.stream = handles.stream;
    session.pcmStream = handles.pcmStream;
    const effectiveOutput = this.prefs.getEffectiveOutputSettings(zoneId);
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
    session.firstAudioReadyAt = undefined;
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

  /**
   * Returns true when this zone still has an actively-driving local playback session.
   * Used by external state controllers to avoid being blocked by stale session objects.
   */
  public hasActiveLocalSession(zoneId: number): boolean {
    const session = this.sessions.get(zoneId);
    if (!session) {
      return false;
    }
    if (session.state !== 'playing') {
      return false;
    }
    if (!session.playbackSource) {
      // Output-only sessions do not own engine playback and should not block external state.
      return false;
    }
    if (!this.playbackService.hasSession(zoneId)) {
      return false;
    }
    const stats = this.playbackService.getSessionStats(zoneId);
    if (!stats.length) {
      return true;
    }
    let maxSubscribers = 0;
    for (const stat of stats) {
      const subscribers = Number.isFinite(stat.subscribers) ? Math.max(0, Math.floor(stat.subscribers)) : 0;
      if (subscribers > maxSubscribers) {
        maxSubscribers = subscribers;
      }
    }
    if (maxSubscribers > 0) {
      return true;
    }
    // Grace window: immediately after start there can be a short no-subscriber period.
    const activeSince =
      session.firstAudioReadyAt ??
      session.playbackStartedAt ??
      session.startedAt ??
      session.updatedAt;
    const ageMs = Number.isFinite(activeSince) ? Math.max(0, Date.now() - Number(activeSince)) : 0;
    return ageMs < 5000;
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
    const base = this.prefs.getEffectiveOutputSettings(zoneId);
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
    const streamExt =
      streamProfile === 'aac'
        ? 'aac'
        : streamProfile === 'flac'
          ? 'flac'
          : streamProfile === 'pcm'
            ? 'wav'
          : streamProfile === 'opus'
            ? 'opus'
            : 'mp3';
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
          preDelayMs: source.preDelayMs,
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
          preDelayMs: source.preDelayMs,
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
      ...(Number.isFinite(outputSettings.fixedGainDb) && outputSettings.fixedGainDb !== 0
        ? { fixedGainDb: outputSettings.fixedGainDb }
        : {}),
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
    const eqBands = this.prefs.getEqualizerResolver()?.(zoneId) ?? null;
    if (eqBands && eqBands.length > 0) {
      options.equalizer = { bands: eqBands };
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
    if (
      (effectiveSource?.kind === 'file' || effectiveSource?.kind === 'pipe') &&
      effectiveSource.realTime === true
    ) {
      effectiveSource = { ...effectiveSource, realTime: false };
    }
    if (
      effectiveSource?.kind === 'url' &&
      effectiveSource.realTime !== true &&
      !metadata?.isRadio
    ) {
      // Default URL inputs to unpaced mode for faster startup; output pacing (and/or true live
      // sources) will keep playback aligned without relying on ffmpeg's `-re`.
      effectiveSource = { ...effectiveSource, realTime: false };
    }
    const inputPrefs = this.prefs.getInputPreferences(zoneId);
    if (inputPrefs?.fileRealTime === false && effectiveSource?.kind === 'file') {
      effectiveSource = { ...effectiveSource, realTime: false };
    }
    if (inputPrefs?.urlRealTime === false && effectiveSource?.kind === 'url') {
      effectiveSource = { ...effectiveSource, realTime: false };
    }
    this.log.info('startWithResolvedSource', {
      zoneId,
      label,
      sourceKind: effectiveSource?.kind ?? null,
      hasStream: effectiveSource ? 'stream' in effectiveSource && !!(effectiveSource as { stream?: unknown }).stream : false,
    });
    const existing = this.sessions.get(zoneId);
    const startAtSec = this.getStartAtSec(effectiveSource);
    const effectivePcmPreference =
      typeof requiresPcm === 'boolean'
        ? requiresPcm
        : this.prefs.getPcmPreference(zoneId) ?? true;
    if (typeof requiresPcm === 'boolean') {
      this.prefs.setPcmPreference(zoneId, requiresPcm);
    }
    const preferredProfile = this.prefs.getProfileOverride(zoneId);
    const profiles = this.computeProfiles(
      effectiveSource,
      effectivePcmPreference,
      preferredProfile ? [preferredProfile] : undefined,
    );
    const effectiveOutput = this.prefs.getEffectiveOutputSettings(zoneId);
    const outputSignature = this.buildOutputSignature(effectiveOutput);
    const outputOnly =
      !effectiveSource && (label.toLowerCase() === 'spotify' || label.toLowerCase() === 'musicassistant');

    const sameSource = Boolean(existing && this.isSamePlaybackSource(existing.playbackSource, effectiveSource));
    const isSpotifyPipe = sameSource && effectiveSource?.kind === 'pipe' && label.toLowerCase() === 'spotify';
    const pendingPlayRequest = this.peekPlayRequest(zoneId);
    const spotifyExplicitServicePlay = isSpotifyPipe && pendingPlayRequest?.type === 'serviceplay';
    const spotifyExplicitTargetChanged =
      spotifyExplicitServicePlay &&
      typeof pendingPlayRequest.uri === 'string' &&
      pendingPlayRequest.uri.length > 0 &&
      pendingPlayRequest.uri !== existing?.playRequestUri;
    const forcePipeRestartOnTrackChange =
      sameSource &&
      effectiveSource?.kind === 'pipe' &&
      (
        this.didTrackChange(existing?.metadata, metadata) ||
        // An explicit Spotify serviceplay is a direct user track selection. Treat it as a
        // hard track switch so we never keep streaming the old pipe under new metadata.
        spotifyExplicitServicePlay ||
        // A paused Spotify pipe must restart on an explicit new play request, otherwise
        // the old pipe session can be resumed with only metadata updated.
        (isSpotifyPipe && existing?.state !== 'playing') ||
        // Zone state patches can update the session metadata before the actual start decision.
        // Fall back to the pending request URI so an explicit serviceplay to a different track
        // still restarts the engine even if metadata already looks "current".
        spotifyExplicitTargetChanged
      );

    // If we are already on the same source (e.g. track change on the same pipe),
    // keep the existing stream URLs and engine session running.
    if (sameSource && !forcePipeRestartOnTrackChange && existing) {
      const now = Date.now();
      const playRequest = this.claimPlayRequest(zoneId);
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
      existing.startedAt = now - startAtSec * 1000;
      existing.updatedAt = now;
      existing.playbackStartedAt = now;
      existing.firstAudioReadyAt = undefined;
      if (playRequest) {
        existing.playRequestAt = playRequest.requestedAt;
        existing.playRequestUri = playRequest.uri;
        existing.playRequestType = playRequest.type;
      }
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
    if (forcePipeRestartOnTrackChange) {
      this.log.info('restarting audio engine for pipe track change', { zoneId, source: label });
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
    const streamProfile = profiles.includes('flac') ? 'flac' : profiles.includes('aac') ? 'aac' : 'mp3';
    const { stream, pcmStream } = this.createStreamHandles(zoneId, streamProfile);
    const playRequest = this.claimPlayRequest(zoneId);
    const now = Date.now();
    const session: PlaybackSession = {
      zoneId,
      source: label,
      metadata,
      stream,
      pcmStream,
      state: 'playing',
      elapsed: startAtSec,
      duration: metadata?.duration ?? 0,
      startedAt: now - startAtSec * 1000,
      updatedAt: now,
      playbackSource: effectiveSource,
      cover: undefined,
      profiles,
      outputSettings: outputSignature,
      playRequestAt: playRequest?.requestedAt,
      playRequestUri: playRequest?.uri,
      playRequestType: playRequest?.type,
      playbackStartedAt: now,
      firstAudioReadyAt: undefined,
    };
    this.sessions.set(zoneId, session);
    this.log.info(outputOnly ? 'playback started (output-only)' : 'playback started', {
      zoneId,
      source: label,
      stream: stream.id,
      title: metadata?.title,
      sincePlayContentMs: playRequest?.requestedAt ? Math.max(0, now - playRequest.requestedAt) : null,
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
      const lk = leftKeys[i];
      const rk = rightKeys[i];
      if (lk !== rk) return false;
      if (lk === undefined || rk === undefined) return false;
      if (left[lk] !== right[rk]) return false;
    }
    return true;
  }

  private didTrackChange(
    prev?: PlaybackMetadata | null,
    next?: PlaybackMetadata | null,
  ): boolean {
    // For same-source pipe playback we must restart if we cannot confidently prove
    // we are on the same track, otherwise buffered old PCM can leak into the new start.
    if (!prev || !next) {
      return true;
    }
    if (prev.trackId || next.trackId) {
      return (prev.trackId ?? '') !== (next.trackId ?? '');
    }
    if (prev.audiopath || next.audiopath) {
      return (prev.audiopath ?? '') !== (next.audiopath ?? '');
    }
    const prevTitle = (prev.title ?? '').trim().toLowerCase();
    const nextTitle = (next.title ?? '').trim().toLowerCase();
    const prevArtist = (prev.artist ?? '').trim().toLowerCase();
    const nextArtist = (next.artist ?? '').trim().toLowerCase();
    const prevAlbum = (prev.album ?? '').trim().toLowerCase();
    const nextAlbum = (next.album ?? '').trim().toLowerCase();
    if (prevTitle || nextTitle || prevArtist || nextArtist || prevAlbum || nextAlbum) {
      return prevTitle !== nextTitle || prevArtist !== nextArtist || prevAlbum !== nextAlbum;
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
    const exitCode = stats?.lastExitCode;
    const exitSignal = stats?.lastExitSignal;
    const stderr = stats?.lastStderr?.trim();
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
    const cleanExit = (exitCode === 0 || exitCode === null) && !exitSignal && !stderr;
    const isFiniteFile = session.playbackSource?.kind === 'file' && !session.metadata?.isRadio;
    if (!reason && cleanExit && (shouldEmitEnded || isFiniteFile)) {
      this.log.info('playback ended', {
        zoneId,
        source: session.source,
        duration,
        elapsed: observedElapsed,
      });
    } else {
      this.log.warn('playback session terminated by engine', {
        zoneId,
        source: session.source,
        reason,
        exitCode,
        exitSignal,
        stderr,
      });
    }
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
          this.prefs.getPcmPreference(zoneId),
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
      const deduped = Array.from(new Set(preferred));
      return deduped;
    }
    if (!playbackSource || playbackSource.kind !== 'pipe') {
      if (requiresPcm) {
        return ['pcm'];
      }
      return ['mp3'];
    }
    return requiresPcm ? (['pcm'] as Array<'pcm'>) : (['mp3'] as Array<'mp3'>);
  }

  /**
   * Restarts a zone's audio engine to pick up new EQ band values. Debounced so rapid
   * Loxone App slider drags coalesce into a single restart.
   */
  public scheduleEqualizerRestart(zoneId: number): void {
    const existing = this.equalizerRestartTimers.get(zoneId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.equalizerRestartTimers.delete(zoneId);
      this.applyEqualizerRestart(zoneId);
    }, AudioManager.EQUALIZER_RESTART_DEBOUNCE_MS);
    timer.unref?.();
    this.equalizerRestartTimers.set(zoneId, timer);
  }

  private applyEqualizerRestart(zoneId: number): void {
    const session = this.sessions.get(zoneId);
    if (!session || !session.playbackSource) {
      return;
    }
    if (!this.playbackService.hasSession(zoneId)) {
      return;
    }
    if (session.state !== 'playing') {
      return;
    }
    // Swap ffmpeg in-place so output subscribers (Squeezelite, Snapcast,
    // Cast, ...) stay attached. The standard PlaybackService.start path
    // calls stop({ discardSubscribers: true }) which destroys their
    // PassThrough streams and forces the user to press Play again.
    const bands = this.prefs.getEqualizerResolver()?.(zoneId) ?? null;
    this.log.info('restarting audio engine to apply equalizer change', { zoneId });
    this.playbackService.restartZoneForEqualizer(zoneId, bands);
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
