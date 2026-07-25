import type { PassThrough } from 'node:stream';
import type { EngineHandoffSpec, EngineStartOptions, OutputProfile, PlaybackSource } from '@/ports/EngineTypes';
import type { AudioOutputSettings } from '@/ports/types/audioFormat';
import type { SessionKey } from '@/ports/types/SessionKey';

export type EngineSessionStats = {
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
};

export type EngineHandoffOptions = EngineHandoffSpec;

export type EngineLocalSession = {
  start: () => void;
  stop: () => void;
  createSubscriber: (options?: { primeWithBuffer?: boolean; label?: string }) => PassThrough | null;
};

export type EngineStopOptions = {
  discardSubscribers?: boolean;
};

export type EngineStreamOptions = {
  primeWithBuffer?: boolean;
  label?: string;
};

export type EngineSessionTerminationHandler = (
  key: SessionKey,
  stats: EngineSessionStats | null,
  reason?: string,
) => void;

export interface EnginePort {
  start(options: EngineStartOptions): void;
  start(
    key: SessionKey,
    source: PlaybackSource,
    profiles?: OutputProfile[],
    outputSettings?: AudioOutputSettings,
  ): void;
  startWithHandoff(options: EngineStartOptions): void;
  startWithHandoff(
    key: SessionKey,
    source: PlaybackSource,
    profiles?: OutputProfile[],
    outputSettings?: AudioOutputSettings,
    options?: EngineHandoffOptions,
  ): void;
  stop(key: SessionKey, reason?: string, options?: EngineStopOptions): void;
  restartZoneForEqualizer(key: SessionKey, bands: ReadonlyArray<number> | null): boolean;
  createStream(key: SessionKey, profile?: OutputProfile, options?: EngineStreamOptions): PassThrough | null;
  createLocalSession(
    key: SessionKey,
    source: PlaybackSource,
    profile: OutputProfile,
    outputSettings: AudioOutputSettings,
    onTerminated: () => void,
  ): EngineLocalSession;
  waitForFirstChunk(key: SessionKey, profile?: OutputProfile, timeoutMs?: number): Promise<boolean>;
  inlineCrossfade(
    key: SessionKey,
    fadeIn:
      | { kind: 'file'; path: string }
      | { kind: 'url'; url: string; headers?: Record<string, string>; decryptionKey?: string }
      | { kind: 'pipe'; stream: NodeJS.ReadableStream; sampleRate: number; channels: number },
    durationSec: number,
  ): Promise<boolean>;
  hasSession(key: SessionKey): boolean;
  getSessionStats(key: SessionKey): EngineSessionStats[];
  setSessionTerminationHandler(handler: EngineSessionTerminationHandler): void;
}
