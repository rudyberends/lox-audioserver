/**
 * What a zone is streaming, for the public API's `format` field.
 *
 * Its own module because both the request path and the event path need it, and they are wired
 * from different places. The source is the engine's session stats — the same one the admin
 * UI's `tech.streamStats` reads — but only the fields that describe the *audio* travel:
 * buffer sizes, restart counts and subscriber drops are engine health, not something a
 * listener is hearing.
 */
import type { ApiStreamFormat } from '@/domain/zones/apiTypes';

/**
 * A zone can have several encoded profiles alive at once — a Cast device pulling MP3 while
 * sendspin takes PCM — so one has to be chosen. The one with subscribers is the one someone
 * is listening to; when several have them, the highest sample rate is the most informative
 * answer for "what am I hearing". Null when nothing is streaming at all.
 */
export
function toStreamFormat(
  stats: Array<{
    profile: string;
    sampleRate: number;
    channels: number;
    pcmBitDepth: number;
    bps: number | null;
    subscribers: number;
  }>,
): ApiStreamFormat | null {
  const live = stats.filter((entry) => entry.subscribers > 0);
  const candidates = live.length > 0 ? live : stats;
  const best = candidates.reduce<(typeof candidates)[number] | null>(
    (winner, entry) => (!winner || entry.sampleRate > winner.sampleRate ? entry : winner),
    null,
  );
  if (!best || !best.sampleRate) {
    return null;
  }
  return {
    codec: best.profile,
    sampleRate: best.sampleRate,
    bitDepth: best.pcmBitDepth,
    channels: best.channels,
    // PCM is a constant rate the encoder does not report; derive nothing and say null.
    bitrate: best.bps ?? null,
  };
}

