import type { PassThrough, Writable } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import { serverClockUs } from '@/shared/audio/serverClock';
import { FfmpegProcess } from '@/engine/ffmpegProcess';
import { FFMPEG_LOW_LATENCY_ARGS } from '@/engine/ffmpegArgs';
import { pcmCodecFromBitDepth, pcmFormatFromBitDepth, type PcmBitDepth } from '@/engine/audioFormat';
import type { EngineSessionStats } from '@/ports/EnginePort';
import type { OutputProfile } from '@/ports/EngineTypes';
import type { SessionKey } from '@/ports/types/SessionKey';

/** How long to wait before looking for a session again when there is nothing to tap yet. */
const RETRY_MS = 1000;

/**
 * How much undecoded audio may sit in front of the decoder before frames are dropped instead.
 *
 * Roughly a second and a half of FLAC — enough that a decoder starting up, or a scheduler hiccup,
 * costs nothing, and small enough that the tap can never be the reason the fan-out throttles a
 * producer. See the write loop in `attach` for why this is a drop and not a queue.
 */
const DECODER_STDIN_CAP_BYTES = 256 * 1024;

/**
 * The demuxer for what a session encodes, as `-f` input args — or nothing when we cannot name it.
 *
 * Note `opus`: the engine muxes it with `-f opus`, which is Opus inside Ogg, so the demuxer that
 * reads it back is `ogg` rather than the encoder's name. A profile with no entry falls back to
 * probing, which works — it is only slower.
 */
function demuxerArgsForProfile(profile: OutputProfile): string[] {
  switch (profile) {
    case 'flac':
      return ['-f', 'flac'];
    case 'mp3':
      return ['-f', 'mp3'];
    case 'aac':
      return ['-f', 'aac'];
    case 'opus':
      return ['-f', 'ogg'];
    default:
      return [];
  }
}

export interface AnalysisFeedEngine {
  getSessionStats(key: SessionKey): EngineSessionStats[];
  createStream(
    key: SessionKey,
    profile?: OutputProfile,
    options?: { primeWithBuffer?: boolean; label?: string },
  ): PassThrough | null;
}

/** The decoding half of a tap. Narrowed to what the feed uses, so a test can stand in for ffmpeg. */
export interface AnalysisDecoder {
  readonly stdin: Writable;
  detach(): void;
  terminate(): void;
}

export interface AnalysisDecoderSpec {
  zoneId: number;
  profile: OutputProfile;
  sampleRate: number;
  channels: number;
  bitDepth: PcmBitDepth;
  onPcm: (pcm: Buffer) => void;
  /** The decoder went away — the tap should be rebuilt against whatever session exists now. */
  onEnded: () => void;
}

export interface AnalysisFeedDeps {
  engine: AnalysisFeedEngine;
  /** Session key for a zone — the engine's map key, which for zone playback is the zone id. */
  sessionKey: (zoneId: number) => SessionKey;
  push: (zoneId: number, pcm: Buffer, timestampUs: number) => void;
  /** Defaults to an ffmpeg decode; overridden in tests. */
  createDecoder?: (spec: AnalysisDecoderSpec) => AnalysisDecoder;
  /** The audio timeline, in microseconds. Defaults to {@link serverClockUs}. */
  now?: () => number;
  /** Defaults to {@link RELEASE_GRACE_MS}; zero in tests that assert teardown directly. */
  releaseGraceMs?: number;
}

/**
 * How long a tap outlives its last consumer.
 *
 * Consumers re-subscribe for reasons that have nothing to do with wanting the audio to stop: the
 * public stream re-arms its analyzer whenever a zone's PCM format changes, which is once per track,
 * and that is an unsubscribe immediately followed by a subscribe. Tearing the tap down in between
 * costs a process kill and a fresh decoder start-up — around a second before the first samples come
 * back — so a display would blank on every track change. Holding it briefly makes a re-subscribe
 * free, and a consumer that is really gone costs one idle decoder for this long.
 */
const RELEASE_GRACE_MS = 5000;

type Tap = {
  stream: PassThrough | null;
  decoder: AnalysisDecoder | null;
  retry: NodeJS.Timeout | null;
  /** Set while the tap is outliving its last consumer; cleared if one comes back. */
  release: NodeJS.Timeout | null;
  stopped: boolean;
};

/**
 * Gives every output a PCM feed for analysis, without any output's audio being touched.
 *
 * The engine only hands PCM to the analysis service when the session's own profile *is* PCM — which
 * is true for Sendspin, AirPlay and Snapcast and false for everything else. So the spectrum, the
 * meters and the pitch readout existed for one family of outputs and silently produced nothing for a
 * Sonos, a Chromecast or a DLNA renderer.
 *
 * The obvious fix — force the engine's own DSP stage on so there is PCM in the middle — is the wrong
 * one, and worth stating plainly because it looks so reasonable: opening a visualizer would then push
 * a zone out of the passthrough that `FfmpegArgBuilder.isBitPerfect` exists to keep it in. A meter
 * that alters the signal it measures is not a meter.
 *
 * So this attaches as an ordinary *subscriber* instead — the same bytes the renderer is already being
 * sent, through the same fan-out, primed the same way — and decodes that copy in a process of its
 * own. The delivered stream cannot be affected by construction: nothing upstream of the fan-out knows
 * this exists, and a subscriber that falls behind is dropped by the fan-out like any other. What it
 * measures is what the listener actually hears, MP3 artefacts and all, which for a meter is more
 * honest than measuring the master it was encoded from.
 *
 * The tap follows the session rather than the track: a session that ends (track change, stop, format
 * switch) closes the subscriber, and the retry loop picks up whatever session exists next.
 */
export class EngineAnalysisFeed {
  private readonly log = createLogger('Audio', 'AnalysisFeed');
  private readonly taps = new Map<number, Tap>();

  constructor(private readonly deps: AnalysisFeedDeps) {}

  /** A zone gained its first analysis consumer. */
  public ensure(zoneId: number): void {
    const existing = this.taps.get(zoneId);
    if (existing) {
      // Whoever just arrived takes over a tap that was on its way out.
      if (existing.release) {
        clearTimeout(existing.release);
        existing.release = null;
      }
      return;
    }
    const tap: Tap = { stream: null, decoder: null, retry: null, release: null, stopped: false };
    this.taps.set(zoneId, tap);
    this.attach(zoneId, tap);
  }

  /** A zone lost its last analysis consumer. Kept alive briefly — see {@link RELEASE_GRACE_MS}. */
  public release(zoneId: number): void {
    const tap = this.taps.get(zoneId);
    if (!tap || tap.release) {
      return;
    }
    const grace = this.deps.releaseGraceMs ?? RELEASE_GRACE_MS;
    if (grace <= 0) {
      this.taps.delete(zoneId);
      this.teardown(tap);
      return;
    }
    tap.release = setTimeout(() => {
      if (this.taps.get(zoneId) === tap) {
        this.taps.delete(zoneId);
      }
      this.teardown(tap);
    }, grace);
    tap.release.unref?.();
  }

  private teardown(tap: Tap): void {
    tap.stopped = true;
    if (tap.retry) {
      clearTimeout(tap.retry);
      tap.retry = null;
    }
    if (tap.release) {
      clearTimeout(tap.release);
      tap.release = null;
    }
    tap.stream?.destroy();
    tap.stream = null;
    if (tap.decoder) {
      // Detach before terminating: the exit handler would otherwise queue another attach for a tap
      // that is being torn down.
      tap.decoder.detach();
      tap.decoder.terminate();
      tap.decoder = null;
    }
  }

  private scheduleRetry(zoneId: number, tap: Tap): void {
    if (tap.stopped || tap.retry) {
      return;
    }
    tap.retry = setTimeout(() => {
      tap.retry = null;
      if (!tap.stopped) {
        this.attach(zoneId, tap);
      }
    }, RETRY_MS);
    tap.retry.unref?.();
  }

  /**
   * Which session to read, or null when the engine is already feeding analysis itself.
   *
   * A PCM-profile session pushes frames straight from `AudioSession.emitOutputChunk`, so tapping one
   * as well would deliver every frame twice. Otherwise only sessions that already have a subscriber
   * qualify: attaching to an idle one would resume a producer that the fan-out had paused precisely
   * because nobody was listening, which would spend CPU on audio going nowhere.
   */
  private pickSession(zoneId: number): EngineSessionStats | null {
    const stats = this.deps.engine.getSessionStats(this.deps.sessionKey(zoneId));
    if (stats.some((entry) => entry.profile === 'pcm')) {
      return null;
    }
    // Same tie-break as the public format readout: whoever is being listened to, and among those the
    // most informative rate — so the format announced to a client matches the one measured here.
    return stats
      .filter((entry) => entry.subscribers > 0 && entry.sampleRate > 0)
      .reduce<EngineSessionStats | null>(
        (best, entry) => (!best || entry.sampleRate > best.sampleRate ? entry : best),
        null,
      );
  }

  private attach(zoneId: number, tap: Tap): void {
    if (tap.stopped || tap.stream) {
      return;
    }
    const session = this.pickSession(zoneId);
    if (!session) {
      this.scheduleRetry(zoneId, tap);
      return;
    }
    const stream = this.deps.engine.createStream(this.deps.sessionKey(zoneId), session.profile, {
      // Live audio only. The rolling buffer holds seconds of already-delivered sound, and priming
      // with it would start every meter that far behind the music.
      primeWithBuffer: false,
      label: 'analysis',
    });
    if (!stream) {
      this.scheduleRetry(zoneId, tap);
      return;
    }
    const bitDepth = (session.pcmBitDepth || 16) as PcmBitDepth;
    const now = this.deps.now ?? serverClockUs;
    const decoder = (this.deps.createDecoder ?? ((spec) => this.spawnDecoder(spec)))({
      zoneId,
      profile: session.profile,
      sampleRate: session.sampleRate,
      channels: session.channels,
      bitDepth,
      onPcm: (chunk) => this.deps.push(zoneId, chunk, now()),
      onEnded: () => this.restart(zoneId, tap),
    });
    // EPIPE is the normal shape of "the decoder went away first"; it is not worth a log line, and
    // an unhandled error on this pipe would take the process down.
    decoder.stdin.on('error', () => undefined);
    /*
     * Feed the decoder by hand, dropping rather than buffering. Emphatically NOT `stream.pipe`.
     *
     * The fan-out treats a subscriber that does not keep up as a slow client: it pauses the
     * *producer* on any subscriber's backpressure and destroys the subscriber once a megabyte has
     * piled up behind it (`SubscriberFanout`, maxLagBytes). Piping into the decoder puts the tap on
     * exactly that path, and both outcomes are wrong. Being evicted is merely useless — the decoder
     * hits EOF, emits one last frame and dies, the retry loop rebuilds it, and the readout becomes
     * one sample every few seconds. Pausing the producer is worse: a meter would be throttling the
     * audio the renderer receives, which is the one thing this design promises it cannot do.
     *
     * It went unnoticed against network sources, which arrive at their own pace and never get ahead
     * of the decoder. A local file does: with `-re` allowing an initial burst, the session can hand
     * over seconds of audio while a freshly spawned ffmpeg is still probing its input. Hence the
     * shape of the bug report — fine on Apple Music, one frame every few seconds on the library.
     *
     * Dropping is the honest failure mode for analysis. A window of samples that skips is a spectrum
     * with a discontinuity in it; a window that arrives seconds late is not a measurement at all.
     */
    let dropped = 0;
    stream.on('data', (chunk: Buffer) => {
      if (decoder.stdin.writableLength > DECODER_STDIN_CAP_BYTES) {
        dropped += chunk.length;
        return;
      }
      if (dropped > 0) {
        this.log.debug('analysis tap dropped audio to stay current', { zoneId, bytes: dropped });
        dropped = 0;
      }
      decoder.stdin.write(chunk);
    });
    stream.on('close', () => this.restart(zoneId, tap));
    tap.stream = stream;
    tap.decoder = decoder;
    this.log.debug('analysis tap attached', {
      zoneId,
      profile: session.profile,
      sampleRate: session.sampleRate,
      channels: session.channels,
      bitDepth,
    });
  }

  /**
   * Decode the tapped copy to PCM at the session's own output format.
   *
   * Matching the session's rate, channel count and depth is not cosmetic: the analyzer is built for
   * one format and reads the bytes by it, so a mismatch does not degrade the readout, it garbles it.
   * Taking the numbers from the session that is being tapped keeps them in step with the format the
   * API announces to the client for the same zone.
   */
  private spawnDecoder(spec: AnalysisDecoderSpec): AnalysisDecoder {
    return new FfmpegProcess(
      [
        '-hide_banner', '-loglevel', 'error',
        ...FFMPEG_LOW_LATENCY_ARGS,
        // Name the container instead of letting ffmpeg probe for it. We know what the session
        // encodes, and probing a *pipe* is not free: measured against a live FLAC subscriber, the
        // first decoded samples took 2425 ms with a probe and 979 ms with `-f flac`, and the frame
        // rate afterwards went from 32/s to 47/s. Same reasoning as the two-stage encoder's PCM
        // input, which spells out its format for exactly this reason.
        ...demuxerArgsForProfile(spec.profile),
        '-i', 'pipe:0',
        '-vn',
        '-acodec', pcmCodecFromBitDepth(spec.bitDepth),
        '-ar', String(spec.sampleRate),
        '-ac', String(spec.channels),
        '-f', pcmFormatFromBitDepth(spec.bitDepth),
        'pipe:1',
      ],
      {
        onStdout: (chunk) => spec.onPcm(chunk),
        onStderr: (message) =>
          this.log.debug('analysis decoder stderr', { zoneId: spec.zoneId, message }),
        onExit: () => spec.onEnded(),
        onError: (error) => {
          this.log.debug('analysis decoder error', { zoneId: spec.zoneId, message: error.message });
          spec.onEnded();
        },
      },
      this.log,
      { logContext: { zoneId: spec.zoneId, profile: spec.profile } },
    );
  }

  /** The tapped session ended. Drop this attempt and look again — a new track spawns a new session. */
  private restart(zoneId: number, tap: Tap): void {
    if (tap.stopped || !this.taps.has(zoneId)) {
      return;
    }
    tap.stream?.destroy();
    tap.stream = null;
    if (tap.decoder) {
      tap.decoder.detach();
      tap.decoder.terminate();
      tap.decoder = null;
    }
    this.scheduleRetry(zoneId, tap);
  }
}
