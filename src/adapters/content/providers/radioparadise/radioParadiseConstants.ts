import type { RadioMenuEntry } from '@/ports/ContentTypes';

export type RadioParadiseStation = {
  id: string;
  name: string;
  description: string;
  streamUrl: string;
  contentType: string;
  apiUrl: string;
  icon: string;
};

export const RADIO_PARADISE_ICON_BASE_URL =
  'https://raw.githubusercontent.com/music-assistant/music-assistant.io/main/docs/assets/icons';

export const RADIO_PARADISE_STATIONS: RadioParadiseStation[] = [
  {
    id: '0',
    name: 'Radio Paradise - Main Mix',
    description: 'Eclectic mix of music - hand-picked by real humans',
    streamUrl: 'https://stream.radioparadise.com/flac',
    contentType: 'audio/flac',
    apiUrl: 'https://api.radioparadise.com/api/now_playing',
    icon: 'radioparadise-logo-main.png',
  },
  {
    id: '1',
    name: 'Radio Paradise - Mellow Mix',
    description: 'A mellower selection from the RP music library',
    streamUrl: 'https://stream.radioparadise.com/mellow-flac',
    contentType: 'audio/flac',
    apiUrl: 'https://api.radioparadise.com/api/now_playing?chan=1',
    icon: 'radioparadise-logo-mellow.png',
  },
  {
    id: '2',
    name: 'Radio Paradise - Rock Mix',
    description: 'Heavier selections from the RP music library',
    streamUrl: 'https://stream.radioparadise.com/rock-flac',
    contentType: 'audio/flac',
    apiUrl: 'https://api.radioparadise.com/api/now_playing?chan=2',
    icon: 'radioparadise-logo-rock.png',
  },
  {
    id: '3',
    name: 'Radio Paradise - Global',
    description: 'Global music and experimental selections',
    streamUrl: 'https://stream.radioparadise.com/global-flac',
    contentType: 'audio/flac',
    apiUrl: 'https://api.radioparadise.com/api/now_playing?chan=3',
    icon: 'radioparadise-logo-global.png',
  },
  {
    id: '4',
    name: 'Radio Paradise - Beyond',
    description: 'Exploring the frontiers of improvisational music',
    streamUrl: 'https://stream.radioparadise.com/beyond-flac',
    contentType: 'audio/flac',
    apiUrl: 'https://api.radioparadise.com/api/now_playing?chan=4',
    icon: 'radioparadise-logo-beyond.png',
  },
  {
    id: '5',
    name: 'Radio Paradise - Serenity',
    description: "Don't panic, and don't forget your towel",
    streamUrl: 'https://stream.radioparadise.com/serenity',
    contentType: 'audio/aac',
    apiUrl: 'https://api.radioparadise.com/api/now_playing?chan=5',
    icon: 'radioparadise-logo-serenity.png',
  },
];

export const RADIO_PARADISE_MENU_ENTRY: RadioMenuEntry = {
  cmd: 'radioparadise',
  name: 'Radio Paradise',
  icon: `${RADIO_PARADISE_ICON_BASE_URL}/radioparadise-logo-main.png`,
  root: 'start',
  description: 'Human-curated, listener-supported radio streams.',
};

export function buildRadioParadiseIconUrl(icon: string): string {
  if (!icon) return '';
  return `${RADIO_PARADISE_ICON_BASE_URL}/${icon}`;
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
