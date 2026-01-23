import { PassThrough } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import { AudioSession, type PlaybackSource, type OutputProfile } from '@/engine/audioSession';
import {
  audioOutputSettings,
  type AudioOutputSettings,
} from '@/engine/audioFormat';

export class AudioStreamEngine {
  private readonly log = createLogger('Audio', 'Engine');
  private readonly sessions = new Map<number, Map<OutputProfile, AudioSession>>();
  private readonly stopReasons = new WeakMap<Map<OutputProfile, AudioSession>, string>();
  private readonly outputSettings = audioOutputSettings;
  private onSessionTerminated?: (
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
  ) => void;

  public setSessionTerminationHandler(
    handler: (
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
    ) => void,
  ): void {
    this.onSessionTerminated = handler;
  }

  public start(
    zoneId: number,
    source: PlaybackSource,
    profiles: OutputProfile[] = ['mp3'],
    outputSettings?: AudioOutputSettings,
  ): void {
    this.stop(zoneId, 'replace', { discardSubscribers: true });
    const profileMap = new Map<OutputProfile, AudioSession>();
    const effectiveOutput = outputSettings ?? this.outputSettings;
    profiles.forEach((profile) => {
      const session = new AudioSession(zoneId, source, profile, () => {
        profileMap.delete(profile);
        const currentMap = this.sessions.get(zoneId);
        if (currentMap !== profileMap) {
          return;
        }
        if (profileMap.size === 0) {
          const stats = session.getStats();
          const stopReason = this.stopReasons.get(profileMap);
          this.stopReasons.delete(profileMap);
          this.sessions.delete(zoneId);
          this.onSessionTerminated?.(zoneId, stats, stopReason);
        }
      }, effectiveOutput);
      profileMap.set(profile, session);
      session.start();
      this.log.info('audio session started', { zoneId, source: source.kind, profile });
    });
    if (profileMap.size > 0) {
      this.sessions.set(zoneId, profileMap);
    }
  }

  public startWithHandoff(
    zoneId: number,
    source: PlaybackSource,
    profiles: OutputProfile[] = ['mp3'],
    outputSettings?: AudioOutputSettings,
    options: { waitProfile?: OutputProfile; timeoutMs?: number } = {},
  ): void {
    const existing = this.sessions.get(zoneId) ?? null;
    const profileMap = new Map<OutputProfile, AudioSession>();
    const effectiveOutput = outputSettings ?? this.outputSettings;
    profiles.forEach((profile) => {
      const session = new AudioSession(zoneId, source, profile, () => {
        profileMap.delete(profile);
        const currentMap = this.sessions.get(zoneId);
        if (currentMap !== profileMap) {
          return;
        }
        if (profileMap.size === 0) {
          const stats = session.getStats();
          const stopReason = this.stopReasons.get(profileMap);
          this.stopReasons.delete(profileMap);
          this.sessions.delete(zoneId);
          this.onSessionTerminated?.(zoneId, stats, stopReason);
        }
      }, effectiveOutput);
      profileMap.set(profile, session);
      session.start();
      this.log.info('audio session started (handoff)', { zoneId, source: source.kind, profile });
    });

    // Make the new sessions available immediately so subscribers bind to the new stream.
    if (profileMap.size > 0) {
      this.sessions.set(zoneId, profileMap);
    }

    const waitProfile = options.waitProfile ?? profiles[0];
    const waitSession =
      (waitProfile ? profileMap.get(waitProfile) : null) ??
      profileMap.values().next().value ??
      null;
    if (!waitSession) {
      profileMap.forEach((session) => session.stop());
      return;
    }
    const timeoutMs = options.timeoutMs ?? 8000;
    void (async () => {
      const ready = await waitSession.waitForFirstChunk(timeoutMs);
      if (!ready) {
        this.log.warn('audio handoff failed; keeping existing session', { zoneId, timeoutMs });
        profileMap.forEach((session) => session.stop());
        if (existing && this.sessions.get(zoneId) === profileMap) {
          this.sessions.set(zoneId, existing);
        }
        return;
      }
      if (existing) {
        this.stopReasons.set(existing, 'switch');
        existing.forEach((session) => session.stop(true));
      }
      this.log.info('audio handoff complete', { zoneId });
    })();
  }

  public stop(
    zoneId: number,
    reason = 'stop',
    options: { discardSubscribers?: boolean } = {},
  ): void {
    const existing = this.sessions.get(zoneId);
    if (!existing) {
      return;
    }
    this.stopReasons.set(existing, reason);
    const discardSubscribers = options.discardSubscribers === true;
    existing.forEach((session) => session.stop(discardSubscribers));
    this.sessions.delete(zoneId);
    this.log.info('audio session stopped', { zoneId });
  }

  public createStream(
    zoneId: number,
    profile: OutputProfile = 'mp3',
    options: { primeWithBuffer?: boolean; label?: string } = {},
  ): PassThrough | null {
    return this.sessions.get(zoneId)?.get(profile)?.createSubscriber(options) ?? null;
  }

  public async waitForFirstChunk(
    zoneId: number,
    profile: OutputProfile = 'mp3',
    timeoutMs = 2000,
  ): Promise<boolean> {
    const session = this.sessions.get(zoneId)?.get(profile);
    if (!session) {
      return false;
    }
    return session.waitForFirstChunk(timeoutMs);
  }

  public hasSession(zoneId: number): boolean {
    return this.sessions.has(zoneId);
  }

  public getSessionStats(
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
    const map = this.sessions.get(zoneId);
    if (!map) return [];
    const stats: Array<{
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
    }> = [];
    for (const session of map.values()) {
      stats.push(session.getStats());
    }
    return stats;
  }
}
