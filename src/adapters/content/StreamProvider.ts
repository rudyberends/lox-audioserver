import type { PlaybackSource } from '@/application/playback/audioManager';

/**
 * A service that can turn one of its own audiopaths into something playable.
 *
 * The playback-side twin of {@link '@/adapters/content/ContentProvider'}: browsing a catalogue
 * and getting a stream out of it are separate concerns, and not every browsable service has a
 * stream resolver of its own (the local library and radio serve their files directly).
 *
 * Six classes had already converged on this shape, each with the predicate named after itself
 * — `isAppleMusicProvider`, `isDeezerProvider`, and so on. That naming is what forced the port
 * above it to carry a `configureX()` and an `isXProvider()` per service, and the adapter to
 * dispatch through a branch per service, twice over.
 */
export interface StreamProvider {
  /** Service-native provider id, e.g. `applemusic`. */
  readonly provider: string;

  /** Re-read this service's configuration (accounts, tokens, cookies). */
  configure(): void;

  /** Whether this service owns the given audiopath prefix, account slug and all. */
  isProvider(providerId: string): boolean;

  startStreamForAudiopath(
    zoneId: number | undefined,
    audiopath: string,
    options?: { suppressErrors?: boolean },
  ): Promise<{ playbackSource: PlaybackSource | null; outputOnly?: boolean }>;
}
