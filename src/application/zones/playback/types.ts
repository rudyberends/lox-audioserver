import type { PlaybackMetadata } from '@/application/playback/audioManager';
import type { QueueAuthority, ZoneContext } from '@/application/zones/internal/zoneTypes';
import type { ParentContext } from '@/application/zones/policies/ParentContextPolicy';
import type { LoxoneZoneState } from '@/domain/loxone/types';

export type InputStartDecision = {
  mode: ZoneContext['inputMode'];
  queueAuthority: QueueAuthority;
};

export type ProviderAction =
  | { type: 'setRadioStationFallback'; value: string };

export type ProviderPatchResult = {
  patch: Partial<LoxoneZoneState>;
  actions?: ProviderAction[];
};

export type VolumeCommandIntent = {
  command: string;
  rawPayload?: string;
  parsed: number;
  isRelative: boolean;
};

export type CommandIntent =
  | { kind: 'PlayResume' }
  | { kind: 'Pause' }
  | { kind: 'StopOff' }
  | { kind: 'Position'; posSeconds: number }
  | { kind: 'Volume'; volume: VolumeCommandIntent }
  | { kind: 'QueueStep'; delta: 1 | -1 }
  | { kind: 'Shuffle'; enabled: boolean | null }
  | { kind: 'Repeat'; value: number | null };

export type ResolvedPlayRequest = {
  uri: string;
  type: string;
  metadata?: PlaybackMetadata;
  parentContext: ParentContext | null;
  hasParentContext: boolean;
  resolvedTarget: string;
  normalizedTarget: string;
  stationUri: string;
  queueAudiopath: string;
  isMusicAssistantInitial: boolean;
  isMusicAssistant: boolean;
  isAppleMusic: boolean;
  isDeezer: boolean;
  isTidal: boolean;
  isSpotify: boolean;
  nextInput: ZoneContext['inputMode'];
  stationValue: string;
  isRadio: boolean;
  queueSourcePath: string;
  targetForQueueBuild: string;
  shouldLimitQueueBuild: boolean;
  queueBuildLimit?: number;
  isLineIn: boolean;
  isAppleMusicUri: boolean;
  isDeezerUri: boolean;
  isTidalUri: boolean;
};
