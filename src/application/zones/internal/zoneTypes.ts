import type { ZoneConfig } from '@/domain/config/types';
import type { LoxoneZoneState } from '@/domain/loxone/types';
import type { PlaybackQueueNavigator } from '@/application/playback/PlaybackQueueNavigator';
import type { InputAdapter } from '@/application/playback/inputAdapter';
import type { SpotifyInputAdapter } from '@/application/playback/adapters/SpotifyInputAdapter';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import type { ZonePlayer } from '@/application/playback/zonePlayer';
import type { QueueItem } from '@/ports/types/queueTypes';

export type { QueueItem } from '@/ports/types/queueTypes';

export type QueueAuthority =
  | 'local'
  | 'spotify'
  | 'musicassistant'
  | 'applemusic'
  | 'deezer'
  | 'tidal'
  | 'ytmusic'
  | 'youtube'
  | 'soundcloud'
  | 'airplay'
  | `external:${string}`;

export interface QueueState {
  items: QueueItem[];
  shuffle: boolean;
  repeat: number;
  currentIndex: number;
  authority: QueueAuthority;
}

export interface AlertSnapshot {
  mode: LoxoneZoneState['mode'];
  inputMode: ZoneContext['inputMode'];
  activeOutput: string | null;
  activeOutputTypes: Set<string>;
  volume: number;
  queue: QueueState;
  statePatch: Partial<LoxoneZoneState>;
}

export interface ActiveAlertState {
  type: string;
  title: string;
  url: string;
  /**
   * Duration (seconds) to expose to Loxone clients for progress/UI.
   * This is intentionally separate from `durationMs`, which may include stop margins.
   */
  reportedDurationSec?: number;
  durationMs?: number;
  stopTimer?: NodeJS.Timeout;
  snapshot: AlertSnapshot;
}

export interface ZoneContext {
  id: number;
  name: string;
  sourceMac: string;
  config: ZoneConfig;
  state: LoxoneZoneState;
  queue: QueueState;
  queueController: PlaybackQueueNavigator;
  inputAdapter: InputAdapter;
  spotifyAdapter: SpotifyInputAdapter;
  metadata: Record<string, unknown>;
  outputs: ZoneOutput[];
  player: ZonePlayer;
  outputTimingActive: boolean;
  lastOutputTimingAt: number;
  /**
   * Throttle zone state broadcasts so Loxone clients aren't hammered.
   */
  lastZoneBroadcastAt: number;
  /**
   * Throttle player position updates to keep state/metadata churn reasonable.
   */
  lastPositionUpdateAt: number;
  lastPositionValue: number;
  lastPlaybackErrorAt: number;
  lastPlaybackErrorReason?: string;
  activeOutputTypes: Set<string>;
  /**
   * Single-output slot for the zone; only this output should receive play/pause/stop/metadata/volume.
   */
  activeOutput: string | null;
  activeInput: string | null;
  /**
   * Throttle metadata dispatch so outputs do not get spammed with time-only updates.
   */
  lastMetadataDispatchAt: number;
  /**
   * Explicit input mode so commands/volume can be gated consistently.
   * queue: local queue/streams, spotify: Spotify Connect, airplay: AirPlay input,
   * musicassistant: MA stream proxy, linein: PCM ingest input
   */
  inputMode:
    | 'queue'
    | 'spotify'
    | 'airplay'
    | 'musicassistant'
    | 'linein'
    | 'mixedgroup'
    | 'alert'
    | null;
  alert?: ActiveAlertState;
  /**
   * Pending pause-time volume reset (resetVolumeOnPause). Held long enough
   * that the receiver buffer has drained and any pre-play volume adjustment
   * gets a chance to override it; cancelled on play/resume/stop and on user
   * volume changes during the window.
   */
  resetVolumeTimer?: NodeJS.Timeout;
}
