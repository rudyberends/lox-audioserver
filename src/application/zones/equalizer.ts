import type { ZoneConfig } from '@/domain/config/types';

export const EQUALIZER_BAND_COUNT = 10;
export const EQUALIZER_MIN_DB = -6;
export const EQUALIZER_MAX_DB = 6;
export const DEFAULT_EQUALIZER_BANDS = Object.freeze(
  Array.from({ length: EQUALIZER_BAND_COUNT }, () => 0),
) as ReadonlyArray<number>;

export type EqualizerBands = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export function normalizeEqualizerBands(value: unknown): EqualizerBands | null {
  if (!Array.isArray(value) || value.length !== EQUALIZER_BAND_COUNT) {
    return null;
  }

  const bands = value.map((entry) => {
    const num = typeof entry === 'number' ? entry : Number(entry);
    if (!Number.isFinite(num)) {
      return null;
    }
    return clampEqualizerBand(Math.round(num));
  });

  if (bands.some((entry) => entry === null)) {
    return null;
  }

  return bands as EqualizerBands;
}

export function parseEqualizerSettings(value: string): EqualizerBands | null {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return normalizeEqualizerBands(parts);
}

export function formatEqualizerSettings(bands: ReadonlyArray<number>): string {
  const normalized = normalizeEqualizerBands([...bands]) ?? [...DEFAULT_EQUALIZER_BANDS];
  return normalized.join(',');
}

export function getZoneEqualizerBands(zone: ZoneConfig): EqualizerBands {
  const stored = normalizeEqualizerBands(zone.equalizer?.bands);
  return stored ?? ([...DEFAULT_EQUALIZER_BANDS] as EqualizerBands);
}

export function resolveSqueezeliteEqCallbackUrl(
  zone: ZoneConfig | undefined | null,
): string | null {
  const output = zone?.output;
  if (!output || String(output.id ?? '').toLowerCase() !== 'squeezelite') {
    return null;
  }

  const raw =
    readStringField(output, 'eqCallbackUrl') ??
    readStringField(output, 'equalizerCallbackUrl') ??
    readStringField(output, 'loxoneEqCallbackUrl');

  if (!raw) {
    return null;
  }

  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function clampEqualizerBand(value: number): number {
  return Math.max(EQUALIZER_MIN_DB, Math.min(EQUALIZER_MAX_DB, value));
}

function readStringField(source: Record<string, unknown>, key: string): string | null {
  const raw = source[key];
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
