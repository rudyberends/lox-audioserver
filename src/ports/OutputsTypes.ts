import type { PlaybackSession } from '@/ports/types/playback';
import type { PcmBitDepth, HttpProfile } from '@/ports/types/audioFormat';

export type PreferredOutput = {
  profile: 'pcm' | 'opus' | 'flac' | 'mp3' | 'aac';
  sampleRate?: number;
  channels?: number;
  bitDepth?: PcmBitDepth;
  /** Optional requested prebuffer size (bytes) for the output pipeline. */
  prebufferBytes?: number;
};

/**
 * A request to play an alert as a native overlay on an output (e.g. Sonos AudioClip).
 * The output ducks the current playback, plays the clip, and restores playback itself —
 * the engine stream is never stopped. Only non-looping alerts are offered this way.
 */
export type NativeAlertRequest = {
  /** Absolute http(s) URL the device can fetch directly (reachable on the LAN). */
  url: string;
  /** Clip playback volume (0..100), already clamped for the zone. */
  volume: number;
  /** Human-friendly label for the clip. */
  title: string;
  /** Alert type ('bell', 'tts', ...). */
  type: string;
};

export type HttpPreferences = {
  httpProfile?: HttpProfile;
  icyEnabled?: boolean;
  icyInterval?: number;
  icyName?: string;
  /**
   * Keep the HTTP response open this many ms after the source ends before closing it.
   * A buffering network renderer (Google Cast holds ~the engine's read-ahead) plays out
   * its buffer after we stop sending; closing immediately makes it glitch/clip the tail.
   * Holding the connection open lets it drain so the close lands at its real end-of-audio.
   */
  drainMsAfterEnd?: number;
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
  /**
   * Optional gapless URL-rotation hook for inline crossfade. After the server-side
   * blend completes and the audio session has rotated its stream id, the coordinator
   * calls this so the output can register the NEW URL as a queued next track. The
   * output is expected to accept the new URL/metadata without flushing the current
   * stream; the coordinator will close the OLD URL's HTTP response after a short
   * pre-buffer window so the output transitions naturally. Returns true on success.
   */
  enqueueRotation?(session: PlaybackSession): Promise<boolean> | boolean;
  /**
   * Returns true when this output supports client-side native crossfade (e.g.
   * squeezelite via SlimProto TransitionType.CROSSFADE). When ALL outputs in a zone
   * return true, the coordinator skips the server-side PCM blend and instead issues
   * a native crossfade via the next play() call.
   */
  supportsCrossfade?(): boolean;
  /**
   * Signal that the NEXT play() call should use native crossfade with the given
   * duration (seconds). The output stores this hint and consumes it on the next play.
   */
  setCrossfadeHint?(durationSec: number): void;
  /** Optional preferred output format for this output (used to drive resampling/profile). */
  getPreferredOutput?(): PreferredOutput | null;
  /** Optional estimated output latency/buffer in milliseconds. */
  getLatencyMs?(): number | null;
  /**
   * Optional drain delay (ms) that the alert coordinator should wait after the
   * alert stream ends and before issuing the next play to this output. Used to
   * let the renderer's own buffer empty before its transport URI is swapped —
   * without this, renderers like Sonos clip the tail of short alerts.
   */
  getAlertHandoffDrainMs?(): number | null;
  /** Optional hot-update for output latency (e.g. snapcast/squeezelite/sendspin). */
  setLatencyMs?(ms: number): Promise<void> | void;
  /** Optional HTTP streaming preferences for outputs that pull via HTTP (e.g. DLNA/Cast). */
  getHttpPreferences?(): HttpPreferences | null;
  /**
   * Optional native (overlay) alert playback. When present, the alert coordinator
   * offers non-looping alerts here instead of the snapshot/replace/resume fallback:
   * the output ducks the current playback, plays the clip, and restores it itself,
   * leaving the engine stream untouched. Returns true when the alert was handled
   * natively; return false (or throw) to make the coordinator fall back to the
   * engine-stream path. Mirrors MA's PlayerFeature.PLAY_ANNOUNCEMENT dispatch.
   */
  playNativeAlert?(request: NativeAlertRequest): Promise<boolean>;
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

/**
 * Admin-facing shape of an output definition: the definition itself plus whether
 * an operator currently offers it when configuring a zone (see
 * `AudioServerConfig.outputs`). Absent means available.
 */
export type TransportConfigDefinition = OutputConfigDefinition;
