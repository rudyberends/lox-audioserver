import type { LineInInputConfig } from '@/domain/config/types';

export const LINEIN_SAMPLE_RATE = 44100;

export function resolveLineInSampleRate(entry?: LineInInputConfig | null): number {
  const source = entry?.source && typeof entry.source === 'object' ? (entry.source as Record<string, unknown>) : null;
  const raw =
    (source?.ingest_sample_rate ?? source?.sample_rate ?? source?.rate ?? source?.sampleRate) as
      | number
      | string
      | undefined;
  const parsed =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim()
        ? Number.parseInt(raw.trim(), 10)
        : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return LINEIN_SAMPLE_RATE;
}

export type LineInIngestResampler = 'linear' | 'sinc-fast' | 'sinc/rubato';

export function resolveLineInIngestResampler(entry?: LineInInputConfig | null): LineInIngestResampler | undefined {
  const source = entry?.source && typeof entry.source === 'object' ? (entry.source as Record<string, unknown>) : null;
  const raw = typeof source?.ingest_resampler === 'string' ? source.ingest_resampler.trim() : '';
  if (raw === 'linear' || raw === 'sinc-fast' || raw === 'sinc/rubato') {
    return raw;
  }
  return undefined;
}

/**
 * Bytes buffered on the receiving end of a line-in ingest before backpressure kicks in.
 *
 * This is latency, not headroom: a line-in is a live source, so anything sitting here is delay
 * between the instrument and the speaker with no benefit. 64 KB of s16le stereo at 48 kHz is ~340 ms.
 * 8 KB is ~42 ms, still several writer chunks deep so a scheduling hiccup does not stall the stream.
 */
export const LINEIN_INGEST_HIGH_WATER_MARK = 8 * 1024;
