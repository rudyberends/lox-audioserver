/**
 * What a zone is streaming, for the public API's `format` field.
 *
 * Its own module because both the request path and the event path need it, and they are wired
 * from different places. The source is the engine's session stats — the same one the admin
 * UI's `tech.streamStats` reads — but only the fields that describe the *audio* travel:
 * buffer sizes, restart counts and subscriber drops are engine health, not something a
 * listener is hearing.
 */
import type { ApiAudioFormat, ApiStreamFormat } from '@/domain/zones/apiTypes';

type StreamStat = {
  profile: string;
  sampleRate: number;
  channels: number;
  pcmBitDepth: number;
  bps: number | null;
  bitPerfect: boolean;
  dspApplied: boolean;
  subscribers: number;
  sourceFormat?: {
    codec: string;
    sampleRate: number;
    channels: number;
    bitDepth: number | null;
    bitrate: number | null;
  } | null;
};

function selectBest(stats: StreamStat[]): StreamStat | null {
  const live = stats.filter((entry) => entry.subscribers > 0);
  const candidates = live.length > 0 ? live : stats;
  return candidates.reduce<StreamStat | null>(
    (winner, entry) => (!winner || entry.sampleRate > winner.sampleRate ? entry : winner),
    null,
  );
}

function isHighRes(sampleRate: number, bitDepth: number | null): boolean {
  return sampleRate > 48000 || (bitDepth !== null && bitDepth > 16);
}

function withHighRes(format: Omit<ApiStreamFormat, 'highRes'>): ApiStreamFormat {
  return { ...format, highRes: isHighRes(format.sampleRate, format.bitDepth) };
}

/**
 * A zone can have several encoded profiles alive at once — a Cast device pulling MP3 while
 * sendspin takes PCM — so one has to be chosen. The one with subscribers is the one someone
 * is listening to; when several have them, the highest sample rate is the most informative
 * answer for "what am I hearing". Null when nothing is streaming at all.
 */
export
function toStreamFormat(
  stats: StreamStat[],
): ApiStreamFormat | null {
  const best = selectBest(stats);
  if (!best || !best.sampleRate) {
    return null;
  }
  return withHighRes({
    codec: best.profile,
    sampleRate: best.sampleRate,
    bitDepth: best.pcmBitDepth,
    channels: best.channels,
    // The engine throughput counter is bytes/sec. The public contract is bits/sec.
    // PCM is exact and should not depend on a short-lived throughput measurement.
    bitrate:
      best.profile === 'pcm'
        ? best.sampleRate * best.channels * best.pcmBitDepth
        : best.bps === null
          ? null
          : best.bps * 8,
  });
}

export function toApiAudioFormat(stats: StreamStat[]): ApiAudioFormat | null {
  const output = toStreamFormat(stats);
  if (!output) {
    return null;
  }
  const source = selectBest(stats)?.sourceFormat ?? null;
  return {
    bitPerfect: selectBest(stats)?.bitPerfect === true,
    dspApplied: selectBest(stats)?.dspApplied === true,
    source: source ? withHighRes(source) : null,
    output,
  };
}
