import type { LineInInputConfig } from '@/domain/config/types';

/**
 * Line-in facts that are pure config reads, kept in the domain so both the
 * adapters and the application layer can use them. The rest of the line-in
 * constants stay next to the transports that own them.
 */

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
