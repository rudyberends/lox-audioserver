import type { PassThrough } from 'node:stream';
import type { EngineHandoffSpec, EngineStartOptions, OutputProfile, PlaybackSource } from '@/ports/EngineTypes';
import type { AudioOutputSettings } from '@/ports/types/audioFormat';

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
  zoneId: number,
  stats: EngineSessionStats | null,
  reason?: string,
) => void;

export interface EnginePort {
  start(options: EngineStartOptions): void;
  start(
    zoneId: number,
    source: PlaybackSource,
    profiles?: OutputProfile[],
    outputSettings?: AudioOutputSettings,
  ): void;
  startWithHandoff(options: EngineStartOptions): void;
  startWithHandoff(
    zoneId: number,
    source: PlaybackSource,
    profiles?: OutputProfile[],
    outputSettings?: AudioOutputSettings,
    options?: EngineHandoffOptions,
  ): void;
  stop(zoneId: number, reason?: string, options?: EngineStopOptions): void;
  createStream(zoneId: number, profile?: OutputProfile, options?: EngineStreamOptions): PassThrough | null;
  createLocalSession(
    zoneId: number,
    source: PlaybackSource,
    profile: OutputProfile,
    outputSettings: AudioOutputSettings,
    onTerminated: () => void,
  ): EngineLocalSession;
  waitForFirstChunk(zoneId: number, profile?: OutputProfile, timeoutMs?: number): Promise<boolean>;
  hasSession(zoneId: number): boolean;
  getSessionStats(zoneId: number): EngineSessionStats[];
  setSessionTerminationHandler(handler: EngineSessionTerminationHandler): void;
}
