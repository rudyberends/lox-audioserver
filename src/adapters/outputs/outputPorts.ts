import type { AirplayGroupCoordinator } from '@/application/outputs/airplayGroupController';
import type { OutputStreamEventsPort } from '@/ports/OutputStreamEventsPort';
import type { SnapcastCorePort } from '@/ports/SnapcastCorePort';
import type { SnapcastGroupCoordinator } from '@/application/outputs/snapcastGroupController';
import type { SendspinGroupCoordinator } from '@/application/outputs/sendspinGroupController';
import type { SonosGroupCoordinator } from '@/application/outputs/sonosGroupController';
import type { SqueezeliteGroupCoordinator } from '@/application/outputs/squeezeliteGroupController';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { EnginePort } from '@/ports/EnginePort';
import type { SendspinHookRegistryPort } from '@/adapters/outputs/sendspin/sendspinHookRegistry';
import type { SpotifyServiceManagerProvider } from '@/adapters/content/providers/spotifyServiceManager';
import type { SpotifyDeviceRegistry } from '@/adapters/outputs/spotify/deviceRegistry';
import type { SqueezeliteCore } from '@/adapters/outputs/squeezelite/squeezeliteCore';
import type { QueueItem } from '@/ports/types/queueTypes';
import type { AudioManager } from '@/application/playback/audioManager';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { GroupManager } from '@/application/groups/groupManager';

type OutputState = {
  status?: 'playing' | 'paused' | 'stopped';
  position?: number;
  duration?: number;
  uri?: string;
};

type OutputHandlers = {
  onQueueUpdate: (zoneId: number, items: QueueItem[], currentIndex: number) => void;
  onOutputError: (zoneId: number, reason?: string) => void;
  onOutputState: (zoneId: number, state: OutputState) => void;
};

type AudioManagerHandle = Pick<
  AudioManager,
  'getSession' | 'getOutputSettings' | 'getEffectiveOutputSettings' | 'startExternalPlayback'
>;

type ZoneManagerHandle = Pick<
  ZoneManagerFacade,
  'getZoneState' | 'handleCommand' | 'setRepeatMode' | 'setShuffle'
>;

type GroupManagerHandle = Pick<GroupManager, 'applySpecGroupVolume'>;

export type OutputPorts = {
  engine: EnginePort;
  audioManager: AudioManagerHandle;
  outputStreamEvents: OutputStreamEventsPort;
  airplayGroup: AirplayGroupCoordinator;
  snapcastCore: SnapcastCorePort;
  snapcastGroup: SnapcastGroupCoordinator;
  sendspinGroup: SendspinGroupCoordinator;
  sendspinHooks: SendspinHookRegistryPort;
  sonosGroup: SonosGroupCoordinator;
  squeezeliteGroup: SqueezeliteGroupCoordinator;
  squeezeliteCore: SqueezeliteCore;
  zoneManager: ZoneManagerHandle;
  groupManager: GroupManagerHandle;
  outputHandlers: OutputHandlers;
  config: ConfigPort;
  spotifyManagerProvider: SpotifyServiceManagerProvider;
  spotifyDeviceRegistry: SpotifyDeviceRegistry;
};
