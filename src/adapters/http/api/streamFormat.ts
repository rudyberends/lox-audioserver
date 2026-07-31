/**
 * What a zone is streaming, for the public API's `format` field.
 *
 * Its own module because both the request path and the event path need it, and they are wired
 * from different places. The source is the engine's session stats — the same one the admin
 * UI's `tech.streamStats` reads — but only the fields that describe the *audio* travel:
 * buffer sizes, restart counts and subscriber drops are engine health, not something a
 * listener is hearing.
 */
import type { ApiAudioFormat, ApiProcessingChain, ApiStreamFormat } from '@/domain/zones/apiTypes';

type StreamStat = {
  profile: string;
  sampleRate: number;
  channels: number;
  pcmBitDepth: number;
  bps: number | null;
  bitPerfect: boolean;
  dspApplied: boolean;
  /** The engine's description of its own filter chain; see `ApiProcessingChain`. */
  processing?: Omit<ApiProcessingChain, 'crossfading'> | null;
  crossfading?: boolean;
  subscribers: number;
  sourceFormat?: {
    codec: string;
    sampleRate: number;
    channels: number;
    bitDepth: number | null;
    bitrate: number | null;
  } | null;
};

/**
 * Which of a zone's live sessions to describe.
 *
 * A zone can have several encoded profiles alive at once — a Cast device pulling MP3 while sendspin
 * takes PCM — and starting a track can leave two sessions of the *same* profile briefly overlapping.
 * So one has to be chosen, in this order:
 *
 *  1. **Someone is listening to it.** A session with subscribers is the one being heard.
 *  2. **The highest sample rate.** Between two people are hearing, the better stream is the more
 *     informative answer to "what am I hearing".
 *  3. **It knows what it is playing.** The tie-breaker that made this comment necessary: an Apple Music
 *     track produced two 44.1 kHz sessions, the first without the provider's declared source format and
 *     the second with it, and a rate comparison alone kept the first — so the API reported "source not
 *     reported" for a track whose format the provider had stated up front. Between otherwise-equal
 *     sessions, the one that can describe its source is strictly more useful.
 */
function selectBest(stats: StreamStat[]): StreamStat | null {
  const live = stats.filter((entry) => entry.subscribers > 0);
  const candidates = live.length > 0 ? live : stats;
  return candidates.reduce<StreamStat | null>((winner, entry) => {
    if (!winner) {
      return entry;
    }
    if (entry.sampleRate !== winner.sampleRate) {
      return entry.sampleRate > winner.sampleRate ? entry : winner;
    }
    if (!winner.sourceFormat && entry.sourceFormat) {
      return entry;
    }
    return winner;
  }, null);
}

/** Codecs that carry every sample of their input. A lossy codec cannot be high-resolution audio. */
const LOSSLESS_CODECS = new Set(['pcm', 'flac', 'alac', 'wav', 'aiff', 'dsd']);

function isLossless(codec: string): boolean {
  const name = codec.toLowerCase();
  return LOSSLESS_CODECS.has(name) || name.startsWith('pcm_');
}

/** Whether a format's own numbers exceed CD: better than 48 kHz, or deeper than 16 bits. */
function exceedsCd(sampleRate: number, bitDepth: number | null): boolean {
  return sampleRate > 48000 || (bitDepth !== null && bitDepth > 16);
}

/**
 * High-resolution is a claim about the *audio*, not about the container it travels in.
 *
 * This used to be `rate > 48k || depth > 16` on whatever format was being described, which made every
 * output of this server high-res: the PCM sink carries 24-bit samples, so a 44.1 kHz AAC decode padded
 * into a 24-bit container was reported as high-res audio. It is a fat box around CD-or-worse content.
 *
 * Two functions rather than one with a nullable source, because the two questions are genuinely
 * different and collapsing them is what made the first attempt wrong: for a *source*, its own numbers
 * are the origin of the claim; for an *output*, they are a claim to be checked against the origin.
 */

/** The source's own numbers, and only lossless codecs can be better than CD. */
function sourceIsHighRes(format: Omit<ApiStreamFormat, 'highRes'>): boolean {
  return isLossless(format.codec) && exceedsCd(format.sampleRate, format.bitDepth);
}

/**
 * The output is high-res only when the information in it can be:
 *
 *  - **Lossless on both ends.** An encoder that threw samples away did so before we saw them; no rate
 *    or depth downstream puts them back.
 *  - **Better than CD in a dimension the source supports.** Depth counts only when the source was
 *    deeper than 16 bits (otherwise it is padding), and rate only when the source ran above 48 kHz
 *    (otherwise it is upsampling). Keeping 24 bits while dropping 96 kHz to 48 kHz is still high-res —
 *    the depth survived — which is why the dimensions are judged separately rather than together.
 *  - **Known.** With no source reported there is nothing to back the claim with, and an unbackable
 *    claim is the one thing this field must not make.
 */
function outputIsHighRes(
  format: Omit<ApiStreamFormat, 'highRes'>,
  source: Omit<ApiStreamFormat, 'highRes'> | null,
): boolean {
  if (!isLossless(format.codec) || !source || !isLossless(source.codec)) {
    return false;
  }
  const deeperThanCd = format.bitDepth !== null && format.bitDepth > 16 && (source.bitDepth ?? 0) > 16;
  const fasterThanCd = format.sampleRate > 48000 && source.sampleRate > 48000;
  return deeperThanCd || fasterThanCd;
}

function withSourceHighRes(format: Omit<ApiStreamFormat, 'highRes'>): ApiStreamFormat {
  return { ...format, highRes: sourceIsHighRes(format) };
}

function withOutputHighRes(
  format: Omit<ApiStreamFormat, 'highRes'>,
  source: Omit<ApiStreamFormat, 'highRes'> | null,
): ApiStreamFormat {
  return { ...format, highRes: outputIsHighRes(format, source) };
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
  // The source is what the output's high-res claim is checked against — see `outputIsHighRes`.
  const source = best.sourceFormat ?? null;
  return withOutputHighRes({
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
  }, source);
}

export function toApiAudioFormat(stats: StreamStat[]): ApiAudioFormat | null {
  const output = toStreamFormat(stats);
  if (!output) {
    return null;
  }
  /*
   * One session decides all of it.
   *
   * `selectBest` was being called four times, which is not just wasteful: with several profiles alive
   * (a Cast device on MP3 while sendspin takes PCM) each call could in principle answer differently, and
   * a verdict from one session beside a chain from another would be a readout that contradicts itself.
   */
  const best = selectBest(stats);
  const source = best?.sourceFormat ?? null;
  return {
    bitPerfect: best?.bitPerfect === true,
    dspApplied: best?.dspApplied === true,
    source: source ? withSourceHighRes(source) : null,
    output,
    // Crossfading lives on the session rather than in the arg builder's description — it is a state,
    // not a configuration — so it is merged in here, where both are on the same object.
    processing: best?.processing
      ? { ...best.processing, crossfading: best.crossfading === true }
      : null,
  };
}
