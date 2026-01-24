import type { PassThrough } from 'node:stream';
import type { AudioStreamEngine } from '@/engine/audioStreamEngine';
import { AudioSession } from '@/engine/audioSession';
import type { EngineHandoffOptions, EngineLocalSession, EnginePort } from '@/ports/EnginePort';
import type {
  EngineInputSpec,
  EngineOutputSpec,
  EngineStartOptions,
  PlaybackSource,
  OutputProfile,
} from '@/ports/EngineTypes';
import { audioOutputSettings, type AudioOutputSettings } from '@/ports/types/audioFormat';

export class EngineAdapter implements EnginePort {
  constructor(private readonly engine: AudioStreamEngine) {}

  public start(options: EngineStartOptions): void;
  public start(
    zoneId: number,
    source: PlaybackSource,
    profiles?: OutputProfile[],
    outputSettings?: AudioOutputSettings,
  ): void;
  public start(
    zoneIdOrOptions: number | EngineStartOptions,
    source?: PlaybackSource,
    profiles?: OutputProfile[],
    outputSettings?: AudioOutputSettings,
  ): void {
    if (typeof zoneIdOrOptions === 'number') {
      this.engine.start(zoneIdOrOptions, source as PlaybackSource, profiles, outputSettings);
      return;
    }
    const { zoneId, input, outputs } = zoneIdOrOptions;
    const playbackSource = this.toPlaybackSource(input);
    const { profiles: resolvedProfiles, outputSettings: resolvedSettings } = this.resolveOutputSpecs(outputs);
    this.engine.start(zoneId, playbackSource, resolvedProfiles, resolvedSettings);
  }

  public startWithHandoff(options: EngineStartOptions): void;
  public startWithHandoff(
    zoneId: number,
    source: PlaybackSource,
    profiles?: OutputProfile[],
    outputSettings?: AudioOutputSettings,
    options?: EngineHandoffOptions,
  ): void;
  public startWithHandoff(
    zoneIdOrOptions: number | EngineStartOptions,
    source?: PlaybackSource,
    profiles?: OutputProfile[],
    outputSettings?: AudioOutputSettings,
    options?: EngineHandoffOptions,
  ): void {
    if (typeof zoneIdOrOptions === 'number') {
      this.engine.startWithHandoff(
        zoneIdOrOptions,
        source as PlaybackSource,
        profiles,
        outputSettings,
        options,
      );
      return;
    }
    const { zoneId, input, outputs, handoff } = zoneIdOrOptions;
    const playbackSource = this.toPlaybackSource(input);
    const { profiles: resolvedProfiles, outputSettings: resolvedSettings } = this.resolveOutputSpecs(outputs);
    this.engine.startWithHandoff(
      zoneId,
      playbackSource,
      resolvedProfiles,
      resolvedSettings,
      handoff ?? undefined,
    );
  }

  public stop(...args: Parameters<EnginePort['stop']>): void {
    this.engine.stop(...args);
  }

  public createStream(...args: Parameters<EnginePort['createStream']>): ReturnType<EnginePort['createStream']> {
    return this.engine.createStream(...args);
  }

  public waitForFirstChunk(...args: Parameters<EnginePort['waitForFirstChunk']>): ReturnType<EnginePort['waitForFirstChunk']> {
    return this.engine.waitForFirstChunk(...args);
  }

  public hasSession(...args: Parameters<EnginePort['hasSession']>): boolean {
    return this.engine.hasSession(...args);
  }

  public getSessionStats(...args: Parameters<EnginePort['getSessionStats']>): ReturnType<EnginePort['getSessionStats']> {
    return this.engine.getSessionStats(...args);
  }

  public setSessionTerminationHandler(...args: Parameters<EnginePort['setSessionTerminationHandler']>): void {
    this.engine.setSessionTerminationHandler(...args);
  }

  public createLocalSession(
    zoneId: number,
    source: PlaybackSource,
    profile: OutputProfile,
    outputSettings: AudioOutputSettings,
    onTerminated: () => void,
  ): EngineLocalSession {
    return new AudioSession(zoneId, source, profile, onTerminated, outputSettings);
  }

  private toPlaybackSource(input: EngineInputSpec): PlaybackSource {
    switch (input.kind) {
      case 'url':
        return {
          kind: 'url',
          url: input.url,
          headers: input.headers,
          decryptionKey: input.decryptionKey,
          tlsVerifyHost: input.tlsVerifyHost,
          inputFormat: input.inputFormat,
          logLevel: input.logLevel,
          startAtSec: input.startAtSec,
          realTime: input.realTime,
          lowLatency: input.lowLatency,
          restartOnFailure: input.restartOnFailure,
        };
      case 'pipe':
        return {
          kind: 'pipe',
          path: input.path,
          format: input.format,
          sampleRate: input.sampleRate,
          channels: input.channels,
          realTime: input.realTime,
          stream: input.stream,
        };
      case 'file':
        return {
          kind: 'file',
          path: input.path,
          loop: input.loop,
          padTailSec: input.padTailSec,
          preDelayMs: input.preDelayMs,
          startAtSec: input.startAtSec,
        };
      case 'silence':
        throw new Error('EngineInputSpec kind "silence" is not supported by the audio engine.');
      default:
        throw new Error('Unknown EngineInputSpec.');
    }
  }

  private resolveOutputSpecs(
    outputs: EngineOutputSpec[] | undefined,
  ): { profiles?: OutputProfile[]; outputSettings?: AudioOutputSettings } {
    if (!outputs || outputs.length === 0) {
      return { profiles: undefined, outputSettings: undefined };
    }
    const profiles = outputs.map((output) => output.profile);
    const primary = outputs[0];
    const outputSettings: AudioOutputSettings = {
      ...audioOutputSettings,
      sampleRate: Number.isFinite(primary.sampleRate) ? primary.sampleRate : audioOutputSettings.sampleRate,
      channels: Number.isFinite(primary.channels) ? primary.channels : audioOutputSettings.channels,
      pcmBitDepth: primary.pcmBitDepth ?? audioOutputSettings.pcmBitDepth,
      prebufferBytes: Number.isFinite(primary.prebufferBytes)
        ? primary.prebufferBytes
        : audioOutputSettings.prebufferBytes,
    };
    return { profiles, outputSettings };
  }
}
