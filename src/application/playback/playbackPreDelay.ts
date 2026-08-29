import type { PlaybackSource } from '@/ports/EngineTypes';
import type { PlaybackSession } from '@/ports/types/playback';

/**
 * Silence (ms) the engine prepends to a source before its first audible sample.
 *
 * It exists to give an amplifier time to leave standby, and it is carried on the
 * playback source itself, so what the engine actually inserted can always be read
 * back from the session it started — no caller has to re-derive it from the zone's
 * settings and risk disagreeing with the engine.
 */
export function resolveSourcePreDelayMs(source: PlaybackSource | null | undefined): number {
  if (!source || !('preDelayMs' in source)) {
    return 0;
  }
  const raw = source.preDelayMs;
  if (!Number.isFinite(raw) || (raw ?? 0) <= 0) {
    return 0;
  }
  return Math.max(0, Math.round(raw ?? 0));
}

/** The wake-up silence at the head of a running session's stream, in ms (0 when there is none). */
export function resolveSessionPreDelayMs(session: PlaybackSession | null | undefined): number {
  return resolveSourcePreDelayMs(session?.playbackSource);
}
