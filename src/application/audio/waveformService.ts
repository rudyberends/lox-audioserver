/**
 * Prepared waveforms: computed once per file, kept, and handed out on request.
 *
 * The whole feature is a cache with a decoder behind it. What makes it worth its own module is the
 * three rules around that:
 *
 *  - **Files only.** `resolvePlaybackSource` is the one place that knows how an audiopath becomes
 *    something on disk, so anything it does not resolve to a `file` — a streaming service, a line-in,
 *    a radio URL — has no waveform and says so. Callers get null and fall back to whatever they draw
 *    while listening.
 *  - **Computed at most once, and never twice at the same time.** A track starting in two rooms, or a
 *    client retrying, must not spawn two decodes of the same file; in-flight work is shared.
 *  - **Never blocks the caller for long.** The first request for a track returns null and starts the
 *    decode in the background, so a play never waits on a picture. The client asks again a moment
 *    later — or gets it on the next event — and by then it is stored.
 *
 * That last rule is a deliberate trade. Waiting up to a second for the first request would give a
 * complete timeline from the first frame; answering immediately keeps the audio path untouched and the
 * UI honest about not knowing yet. The audio matters more.
 */
import { promises as fs } from 'node:fs';
import { resolvePlaybackSource } from '@/application/playback/sourceResolver';
import { computeWaveform, WAVEFORM_BUCKETS } from '@/engine/waveform';
import { createLogger } from '@/shared/logging/logger';

export type WaveformStore = {
  getWaveform: (
    path: string,
    file?: { size: number; mtimeMs: number },
  ) => { buckets: Uint8Array; durationMs: number | null } | null;
  upsertWaveform: (entry: {
    path: string;
    buckets: Uint8Array;
    durationMs: number | null;
    file?: { size: number; mtimeMs: number };
  }) => void;
};

export type WaveformResult = {
  /** One byte per bucket: level as a position in the analysis dB window, 0…255. */
  buckets: number[];
  durationMs: number | null;
  buckets_total: number;
};

export class WaveformService {
  private readonly log = createLogger('Audio', 'Waveform');
  /** Decodes in flight, keyed by audiopath, so the same file is never scanned twice at once. */
  private readonly inFlight = new Map<string, Promise<void>>();
  /** Paths that failed, so a broken file is not retried on every poll. */
  private readonly failed = new Set<string>();

  public constructor(private readonly store: WaveformStore) {}

  /**
   * The stored waveform for an audiopath, or null.
   *
   * Null carries two different situations and the caller cannot tell them apart on purpose: this
   * audiopath can never have one (a stream), or it does not have one *yet* (a file being decoded).
   * Both mean "draw what you can" today, and conflating them keeps the caller from having to encode a
   * retry policy for something that resolves itself within a second.
   */
  public get(audiopath: string): WaveformResult | null {
    const path = this.filePathFor(audiopath);
    if (!path) {
      return null;
    }
    const stored = this.store.getWaveform(path);
    if (stored) {
      return {
        buckets: [...stored.buckets],
        durationMs: stored.durationMs,
        buckets_total: stored.buckets.length,
      };
    }
    void this.prepare(audiopath, path);
    return null;
  }

  /**
   * Compute and store the waveform for an audiopath, if it is a file and has none.
   *
   * Public because the interesting caller is playback: a track that has just started is exactly the
   * one whose shape will be asked for, and starting the decode then means the answer is usually ready
   * before anything asks.
   */
  public async prepare(audiopath: string, knownPath?: string): Promise<void> {
    const path = knownPath ?? this.filePathFor(audiopath);
    if (!path || this.failed.has(path)) {
      return;
    }
    // Keyed by the file, not by the audiopath: the same track arrives as a raw `library://` path
    // and as an opaque browse id, and one decode should serve both.
    const existing = this.inFlight.get(path);
    if (existing) {
      return existing;
    }
    const work = this.compute(path).finally(() => this.inFlight.delete(path));
    this.inFlight.set(path, work);
    return work;
  }

  private async compute(path: string): Promise<void> {
    let file: { size: number; mtimeMs: number } | undefined;
    try {
      const stat = await fs.stat(path);
      file = { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      // Unreadable now; the decode below will fail too and mark it, so nothing is assumed here.
    }
    if (file && this.store.getWaveform(path, file)) {
      return;
    }
    const waveform = await computeWaveform(path);
    if (!waveform) {
      this.failed.add(path);
      return;
    }
    this.store.upsertWaveform({
      path,
      buckets: waveform.buckets,
      durationMs: waveform.durationMs,
      ...(file ? { file } : {}),
    });
    this.log.debug('waveform stored', { path, durationMs: waveform.durationMs, buckets: WAVEFORM_BUCKETS });
  }

  /** The file behind an audiopath, or null when it is not backed by one. */
  private filePathFor(audiopath: string): string | null {
    const source = resolvePlaybackSource(audiopath);
    return source && source.kind === 'file' ? source.path : null;
  }
}
