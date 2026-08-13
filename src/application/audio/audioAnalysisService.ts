/**
 * The dB window the u16 values on the wire span.
 *
 * `loudness`, `spectrum` and `f_peak` do not carry an amplitude: they carry the amplitude's
 * *position in dB* across [ANALYSIS_DB_FLOOR, 0] dBFS, linear in dB, as 0…65535. This is the
 * sendspin visualizer@v1 encoding, and it is the part consumers get wrong — taking `20·log10` of a
 * value that is already logarithmic maps a true −20 dBFS to 94% of full scale, which looks like
 * music that is permanently clipping.
 *
 * So: `dB = floor + (value / fullScale) · |floor|`, and a display height is `value / fullScale`
 * with no conversion at all. Stated here, in the neutral contract, rather than as a constant each
 * analyzer and each client re-declares for itself.
 */
export const ANALYSIS_DB_FLOOR = -60;
export const ANALYSIS_FULL_SCALE = 65535;

export type AudioAnalysisEvent =
  | { type: 'loudness'; value: number; timestampUs: number }
  | { type: 'spectrum'; bins: Uint16Array; timestampUs: number }
  | { type: 'f_peak'; frequencyHz: number; amplitude: number; timestampUs: number }
  | { type: 'peak'; strength: number; timestampUs: number }
  | { type: 'pitch'; midiQ88: number; confidence: number; timestampUs: number }
  /** Front left/right levels in the same u16 dB encoding as `loudness`. Mono reports both equal. */
  | { type: 'stereo'; left: number; right: number; timestampUs: number };

export type AudioAnalysisSubscription = {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  rateMax: number;
  /** Which PCM timeline feeds this consumer. Engine time is used by the API. */
  feed?: 'engine' | 'scheduled-output';
  loudness?: boolean;
  fPeak?: boolean;
  peak?: boolean;
  pitch?: boolean;
  stereo?: boolean;
  spectrum?: {
    n_disp_bins: number;
    scale: 'lin' | 'log' | 'mel';
    f_min: number;
    f_max: number;
  };
};

export type AudioAnalysisListener = (event: AudioAnalysisEvent) => void;

export type AudioAnalysisAnalyzer = { push: (pcm: Buffer, timestampUs: number) => void };
export type AudioAnalysisAnalyzerFactory = (
  options: AudioAnalysisSubscription,
  listener: AudioAnalysisListener,
) => AudioAnalysisAnalyzer;

type Subscription = {
  analyzer: AudioAnalysisAnalyzer;
  feed: 'engine' | 'scheduled-output';
};

/**
 * Asked to arrange PCM for a zone that has consumers but no producer.
 *
 * Outputs that run a PCM session push frames of their own accord; the rest need something to go and
 * fetch the audio. That is a decision about *sessions*, which this service knows nothing about, so it
 * only reports the transitions: first engine-feed consumer for a zone, and last one gone.
 */
export interface AudioAnalysisFeedController {
  ensure(zoneId: number): void;
  release(zoneId: number): void;
}

/**
 * Protocol-neutral owner of realtime audio analysis.
 *
 * Outputs feed PCM into this service and subscribe to normalized events. A future web/API
 * consumer can subscribe here without making the analysis implementation depend on Sendspin.
 * No analyzer exists until a consumer subscribes.
 */
export class AudioAnalysisService {
  private readonly subscriptions = new Map<number, Map<symbol, Subscription>>();
  private feedController: AudioAnalysisFeedController | null = null;

  constructor(private readonly createAnalyzer: AudioAnalysisAnalyzerFactory) {}

  /**
   * Wire the thing that produces PCM for outputs which do not push it themselves. Set once during
   * bootstrap; without it the service behaves exactly as before and only sees what outputs push.
   */
  public setFeedController(controller: AudioAnalysisFeedController | null): void {
    this.feedController = controller;
  }

  public subscribe(
    zoneId: number,
    options: AudioAnalysisSubscription,
    listener: AudioAnalysisListener,
  ): () => void {
    const token = Symbol(`audio-analysis-${zoneId}`);
    const analyzer = this.createAnalyzer(options, listener);
    let zoneSubscriptions = this.subscriptions.get(zoneId);
    if (!zoneSubscriptions) {
      zoneSubscriptions = new Map();
      this.subscriptions.set(zoneId, zoneSubscriptions);
    }
    const feed = options.feed ?? 'engine';
    zoneSubscriptions.set(token, { analyzer, feed });
    if (feed === 'engine' && this.engineConsumers(zoneId) === 1) {
      this.feedController?.ensure(zoneId);
    }
    return () => {
      const current = this.subscriptions.get(zoneId);
      if (!current?.delete(token)) {
        return;
      }
      if (feed === 'engine' && this.engineConsumers(zoneId) === 0) {
        this.feedController?.release(zoneId);
      }
      if (current.size === 0) {
        this.subscriptions.delete(zoneId);
      }
    };
  }

  private engineConsumers(zoneId: number): number {
    let count = 0;
    for (const subscription of this.subscriptions.get(zoneId)?.values() ?? []) {
      if (subscription.feed === 'engine') {
        count += 1;
      }
    }
    return count;
  }

  public push(
    zoneId: number,
    pcm: Buffer,
    timestampUs: number,
    feed: 'engine' | 'scheduled-output' = 'engine',
  ): void {
    const zoneSubscriptions = this.subscriptions.get(zoneId);
    if (!zoneSubscriptions) {
      return;
    }
    for (const subscription of zoneSubscriptions.values()) {
      if (subscription.feed === feed) {
        subscription.analyzer.push(pcm, timestampUs);
      }
    }
  }
}
