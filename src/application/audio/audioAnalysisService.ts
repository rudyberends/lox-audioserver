export type AudioAnalysisEvent =
  | { type: 'loudness'; value: number; timestampUs: number }
  | { type: 'spectrum'; bins: Uint16Array; timestampUs: number }
  | { type: 'f_peak'; frequencyHz: number; amplitude: number; timestampUs: number }
  | { type: 'peak'; strength: number; timestampUs: number }
  | { type: 'pitch'; midiQ88: number; confidence: number; timestampUs: number };

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
 * Protocol-neutral owner of realtime audio analysis.
 *
 * Outputs feed PCM into this service and subscribe to normalized events. A future web/API
 * consumer can subscribe here without making the analysis implementation depend on Sendspin.
 * No analyzer exists until a consumer subscribes.
 */
export class AudioAnalysisService {
  private readonly subscriptions = new Map<number, Map<symbol, Subscription>>();

  constructor(private readonly createAnalyzer: AudioAnalysisAnalyzerFactory) {}

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
    zoneSubscriptions.set(token, { analyzer, feed: options.feed ?? 'engine' });
    return () => {
      const current = this.subscriptions.get(zoneId);
      current?.delete(token);
      if (current?.size === 0) {
        this.subscriptions.delete(zoneId);
      }
    };
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
