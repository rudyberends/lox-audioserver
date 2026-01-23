import type { PlaybackSession } from '@/application/playback/audioManager';
import type { PcmBitDepth, HttpProfile } from '@/ports/types/audioFormat';

export type PreferredOutput = {
  profile: 'pcm' | 'opus' | 'flac' | 'mp3' | 'aac';
  sampleRate?: number;
  channels?: number;
  bitDepth?: PcmBitDepth;
  /** Optional requested prebuffer size (bytes) for the output pipeline. */
  prebufferBytes?: number;
};

export type HttpPreferences = {
  httpProfile?: HttpProfile;
  icyEnabled?: boolean;
  icyInterval?: number;
  icyName?: string;
};

export interface ZoneOutput {
  readonly type: string;
  play(session: PlaybackSession): Promise<void> | void;
  pause(session: PlaybackSession | null): Promise<void> | void;
  resume(session: PlaybackSession | null): Promise<void> | void;
  stop(session: PlaybackSession | null): Promise<void> | void;
  setVolume?(level: number): Promise<void> | void;
  setPosition?(seconds: number): Promise<void> | void;
  stepQueue?(delta: number): Promise<void> | void;
  /** Optional hook to push metadata/cover updates without restarting playback. */
  updateMetadata?(session: PlaybackSession | null): Promise<void> | void;
  /** Optional preferred output format for this output (used to drive resampling/profile). */
  getPreferredOutput?(): PreferredOutput | null;
  /** Optional estimated output latency/buffer in milliseconds. */
  getLatencyMs?(): number | null;
  /** Optional HTTP streaming preferences for outputs that pull via HTTP (e.g. DLNA/Cast). */
  getHttpPreferences?(): HttpPreferences | null;
  dispose(): Promise<void> | void;
}

export type ZoneTransport = ZoneOutput;

export interface OutputFieldDefinition {
  id: string;
  label: string;
  type: 'text';
  placeholder?: string;
  description?: string;
  required?: boolean;
}

export type TransportFieldDefinition = OutputFieldDefinition;

export interface OutputConfigDefinition {
  id: string;
  label: string;
  description?: string;
  fields: OutputFieldDefinition[];
}

export type TransportConfigDefinition = OutputConfigDefinition;
