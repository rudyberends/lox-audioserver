import type { PassThrough } from 'node:stream';
import type { ProcessingChain } from '@/engine/ffmpegArgs';
import type { EngineHandoffSpec, EngineStartOptions, OutputProfile, PlaybackSource } from '@/ports/EngineTypes';
import type { AudioOutputSettings } from '@/ports/types/audioFormat';
import type { SessionKey } from '@/ports/types/SessionKey';

export type EngineSessionStats = {
  profile: OutputProfile;
  /**
   * The format this session actually encodes at. Callers must compare this — not
   * just `profile` — before reusing a session: a 48 kHz FLAC session matches the
   * 'flac' profile of a 96 kHz request, and reusing it would stream 48 kHz frames
   * under a stream/start that announced 96 kHz, which makes clients fail to decode.
   */
  sampleRate: number;
  channels: number;
  pcmBitDepth: number;
  bps: number | null;
  /** True only when a lossless source reaches the output without DSP or conversion. */
  bitPerfect: boolean;
  /** True when this server performs conversion, filtering, gain, delay or re-encoding. */
  dspApplied: boolean;
  /**
   * *What* it performs, stage by stage — see `ProcessingChain`.
   *
   * `dspApplied` answers "did anything touch this"; a listener with good speakers wants the next
   * question answered too, and the session already knows every part of it.
   */
  processing?: ProcessingChain | null;
  /** True while the two-stage crossfade path is blending, which requantises by definition. */
  crossfading?: boolean;
  /** Native source format when declared or successfully probed. */
  sourceFormat?: {
    codec: string;
    sampleRate: number;
    channels: number;
    bitDepth: number | null;
    bitrate: number | null;
  } | null;
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
