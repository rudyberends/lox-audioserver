import type { RadioMenuEntry } from '@/ports/ContentTypes';
import { RADIO_PARADISE_STATIONS as RADIO_PARADISE_STATIONS_SHARED } from '@/domain/radioparadise/stations';
import type { RadioParadiseStation } from '@/domain/radioparadise/stations';

export type { RadioParadiseStation };
export const RADIO_PARADISE_STATIONS = RADIO_PARADISE_STATIONS_SHARED;

export const RADIO_PARADISE_ICON_BASE_URL =
  '/assets/icons';

export const RADIO_PARADISE_MENU_ENTRY: RadioMenuEntry = {
  cmd: 'radioparadise',
  name: 'Radio Paradise',
  icon: `${RADIO_PARADISE_ICON_BASE_URL}/radioparadise-logo-main.png`,
  root: 'start',
  description: 'Human-curated, listener-supported radio streams.',
};

export function buildRadioParadiseIconUrl(icon: string, baseUrl = RADIO_PARADISE_ICON_BASE_URL): string {
  if (!icon) return '';
  return `${baseUrl.replace(/\/+$/, '')}/${icon}`;
}

export function normalizeRadioParadiseStreamUrl(value: string): string {
  const raw = value.trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return raw.replace(/\/$/, '').toLowerCase();
  }
}

const STATION_BY_STREAM = new Map<string, RadioParadiseStation>();
for (const station of RADIO_PARADISE_STATIONS) {
  STATION_BY_STREAM.set(normalizeRadioParadiseStreamUrl(station.streamUrl), station);
}

export function resolveRadioParadiseStationByStream(streamUrl: string): RadioParadiseStation | null {
  const normalized = normalizeRadioParadiseStreamUrl(streamUrl);
  return STATION_BY_STREAM.get(normalized) ?? null;
}
