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
    return clampEqualizerBand(num);
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

/**
 * Resolves the EQ-forward URL for a zone based on its configured equalizer provider.
 * Returns null when no provider is configured, the provider is 'off', or the URL is invalid.
 */
export function resolveEqForwardUrl(zone: ZoneConfig | undefined | null): string | null {
  const eq = zone?.equalizer;
  if (!eq || eq.provider !== 'squeezelite-mr') {
    return null;
  }
  const raw = typeof eq.callbackUrl === 'string' ? eq.callbackUrl.trim() : '';
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

/**
 * ISO 10-band centre frequencies (Hz) used by the Loxone App's EQ grid.
 * Index matches the band index exposed via `audio/cfg/geteq` and `seteq`.
 */
export const EQUALIZER_BAND_FREQUENCIES = Object.freeze([
  31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
]) as ReadonlyArray<number>;

/** Q factor used for each band; ~1 octave wide so adjacent bands overlap smoothly. */
const EQUALIZER_BAND_Q = 1.0;

/**
 * Builds an ffmpeg `-af` filter chain for the given EQ band gains. Returns null when no
 * audible band is set (all gains effectively zero) so the caller can omit the filter
 * entirely.
 */
export function buildEqualizerFilterChain(
  bands: ReadonlyArray<number> | null | undefined,
): string | null {
  if (!bands || bands.length === 0) {
    return null;
  }
  const filters: string[] = [];
  for (let i = 0; i < EQUALIZER_BAND_FREQUENCIES.length; i++) {
    const gain = Number(bands[i] ?? 0);
    if (!Number.isFinite(gain) || Math.abs(gain) < 0.05) {
      continue;
    }
    const freq = EQUALIZER_BAND_FREQUENCIES[i];
    const gainStr = formatGain(gain);
    filters.push(`equalizer=f=${freq}:t=q:w=${EQUALIZER_BAND_Q}:g=${gainStr}`);
  }
  return filters.length ? filters.join(',') : null;
}

function formatGain(value: number): string {
  // ffmpeg accepts integers and decimals; trim trailing zeroes for readability.
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(2).replace(/\.?0+$/, '');
}
