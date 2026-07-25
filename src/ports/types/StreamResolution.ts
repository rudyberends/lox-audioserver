import type { PlaybackMetadata } from '@/ports/types/playback';
import type { PlaybackSource } from '@/ports/EngineTypes';

/**
 * Who is asking to resolve a playback source.
 *
 * - `zone`: normal per-zone playback. The zoneId scopes the resolve cache and is
 *   the target for stream-resolution error routing (notifyOutputError).
 * - `ephemeral`: a non-zone consumer (e.g. the DLNA media server serving a track
 *   to an arbitrary renderer). No zone to route errors to, and no per-zone cache
 *   partitioning — resolved stream URLs are request-scoped, so sharing is safe.
 */
export type PlaybackResolveRequester =
  | { kind: 'zone'; zoneId: number }
  | { kind: 'ephemeral' };

export type PlaybackSourceResolveArgs = {
  audiopath: string;
  prefetch?: boolean;
  requester?: PlaybackResolveRequester;
};

export type StreamResolution = {
  playbackSource?: PlaybackSource | null;
  outputOnly?: boolean;
  metadata?: Partial<PlaybackMetadata>;
  provider?: string;
  errorReason?: string;
};
