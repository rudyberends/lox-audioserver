import type { OutputProfile, PlaybackSource } from '@/ports/EngineTypes';
import type { AudioOutputSettings } from '@/ports/types/audioFormat';

export interface PlaybackMetadata {
  title: string;
  artist: string;
  album: string;
  coverurl?: string;
  animatedCoverUrl?: string;
  duration?: number;
  isRadio?: boolean;
  /**
   * Marks a short announcement/alert (TTS, event file, recorded message). Sonos must not be
   * told the clip's duration in DIDL, otherwise it stops at that mark and clips the tail
   * (issues #262/#276/#279); the alert session ends on the encoder's EOF instead.
   */
  isAlert?: boolean;
  /** Optional absolute audiopath/uri (e.g. spotify:track:abc123) to preserve in queue. */
  audiopath?: string;
  /** Optional provider-specific track id (e.g. spotify track id). */
  trackId?: string;
  /** Optional playback context (e.g. spotify album/playlist URI). */
  station?: string;
  /** Optional index into the station/context (e.g. playlist position). */
  stationIndex?: number;
  /** Optional full queue of URIs for output/controller to use (e.g. Spotify Connect). */
  queue?: string[];
  /** Optional index within the provided queue. */
  queueIndex?: number;
}

export interface AudioStreamHandle {
  id: string;
  url: string;
  coverUrl: string;
  createdAt: number;
}

export interface CoverArtPayload {
  data: Buffer;
  mime: string;
}

export interface PlaybackSession {
  zoneId: number;
  source: string;
  metadata?: PlaybackMetadata;
  stream: AudioStreamHandle;
  pcmStream?: AudioStreamHandle;
  state: 'playing' | 'paused' | 'stopped';
  elapsed: number;
  duration: number;
  startedAt: number;
  updatedAt: number;
  playbackSource: PlaybackSource | null;
  cover?: CoverArtPayload;
  profiles?: OutputProfile[];
  outputSettings?: Pick<AudioOutputSettings, 'sampleRate' | 'channels' | 'pcmBitDepth'>;
  playRequestAt?: number;
  playRequestUri?: string;
  playRequestType?: string;
  playbackStartedAt?: number;
  firstAudioReadyAt?: number;
  /** Wall-clock timestamp (ms) when the last inline crossfade blend completed. Set by inlineCrossfadePlayback. */
  crossfadedAt?: number;
  /**
   * Stream IDs that were `session.stream.id` until rotated by `rotateStreamId()`.
   * The HTTP handler accepts requests for any non-expired entry so existing subscriber
   * connections (and brief reconnects) keep working during the gapless URL handover.
   */
  recentStreamIds?: { id: string; expiresAt: number }[];
}

/**
 * What a playback error is about, when the reporter knows.
 *
 * Errors from an input service travel to the zone asynchronously, and by the time one
 * lands the zone may well be playing something else: an announcement, the next track,
 * another input. Acting on it then stops the wrong thing — a TTS clip fell silent
 * because the librespot session it had just replaced reported a dead audio key (#293).
 * Naming the input lets the zone drop what it has moved past. Omit it for errors about
 * the zone's renderer, which apply whatever the source.
 */
export type PlaybackErrorOrigin = {
  /** The input service reporting; its errors only count while it is the zone's input. */
  input: 'spotify' | 'airplay' | 'musicassistant' | 'linein' | 'bluetooth' | 'dlna';
};
