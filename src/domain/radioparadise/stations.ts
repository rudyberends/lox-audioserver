export type RadioParadiseStation = {
  id: string;
  name: string;
  description: string;
  streamUrl: string;
  contentType: string;
  apiUrl: string;
  icon: string;
};

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

export const RADIO_PARADISE_LABELS = new Map<string, string>(
  RADIO_PARADISE_STATIONS.map((station) => [station.id, station.name]),
);

export const RADIO_PARADISE_STREAMS = new Map<string, { streamUrl: string; nowPlayingUrl: string }>(
  RADIO_PARADISE_STATIONS.map((station) => [
    station.id,
    {
      streamUrl: station.streamUrl,
      nowPlayingUrl: station.apiUrl,
    },
  ]),
);

export const RADIO_PARADISE_PATH_LABELS = new Map<string, string>(
  RADIO_PARADISE_STATIONS.map((station) => [toPathKey(station.streamUrl), station.name]),
);

function toPathKey(streamUrl: string): string {
  try {
    const url = new URL(streamUrl);
    const path = url.pathname.replace(/\/$/, '').toLowerCase();
    return path || '/';
  } catch {
    const fallback = streamUrl.trim().replace(/\/$/, '').toLowerCase();
    return fallback || '/';
  }
}
