import type { PlaybackSession } from '@/modules/audio';
import type { PcmBitDepth } from '@/modules/audio/utils/audioFormat';
import type { HttpProfile } from '@/modules/audio/utils/audioFormat';

export type PreferredOutput = {
  profile: 'pcm' | 'opus' | 'flac' | 'mp3';
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

export interface ZoneTransport {
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
  /** Optional preferred output format for this transport (used to drive resampling/profile). */
  getPreferredOutput?(): PreferredOutput | null;
  /** Optional HTTP streaming preferences for transports that pull via HTTP (e.g. DLNA/Cast). */
  getHttpPreferences?(): HttpPreferences | null;
  dispose(): Promise<void> | void;
}

export interface TransportFieldDefinition {
  id: string;
  label: string;
  type: 'text';
  placeholder?: string;
  description?: string;
  required?: boolean;
}

export interface TransportConfigDefinition {
  id: string;
  label: string;
  description?: string;
  fields: TransportFieldDefinition[];
}
