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
