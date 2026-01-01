import { API_BASE } from '../config/apiConfig';

export type ContentUpdatePayload = {
  radio?: {
    tuneInUsername?: string | null;
  };
  spotify?: {
    clientId?: string | null;
  };
  library?: {
    enabled?: boolean;
    autoScan?: boolean;
  };
};

export type InputsUpdatePayload = {
  airplay?: { enabled?: boolean };
  spotify?: { enabled?: boolean };
  bluetooth?: { enabled?: boolean };
  lineIn?: { source?: string | null };
};

export async function updateContentConfig(payload: ContentUpdatePayload): Promise<void> {
  const res = await fetch(`${API_BASE}/config/content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to update content settings');
  }
}

export async function updateInputsConfig(payload: InputsUpdatePayload): Promise<void> {
  const res = await fetch(`${API_BASE}/config/inputs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to update input settings');
  }
}

export type LibraryStatusResponse = {
  status: number;
  trackCount?: number | null;
  albumCount?: number | null;
  artistCount?: number | null;
};

export type LibraryCoverSample = {
  album: string;
  artist: string;
  coverurl: string;
};

export async function fetchLibraryStatus(): Promise<LibraryStatusResponse> {
  const res = await fetch(`${API_BASE}/content/library/status`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to fetch library status');
  }
  return (await res.json()) as LibraryStatusResponse;
}

export async function fetchLibraryCovers(limit = 8): Promise<{ covers?: LibraryCoverSample[] }> {
  const res = await fetch(`${API_BASE}/content/library/covers?limit=${encodeURIComponent(String(limit))}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to fetch library covers');
  }
  return (await res.json()) as { covers?: LibraryCoverSample[] };
}

export async function uploadLibraryAudio(
  filename: string,
  base64Data: string,
  relativePath?: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/content/library/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, relativePath, data: base64Data }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to upload audio');
  }
}

export async function triggerLibraryRescan(): Promise<void> {
  const res = await fetch(`${API_BASE}/content/library/rescan`, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to trigger library rescan');
  }
}

export async function fetchSpotifyAuthLink(): Promise<{ link?: string }> {
  const res = await fetch(`${API_BASE}/spotify/accounts/link`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to build Spotify auth link');
  }
  return (await res.json()) as { link?: string };
}

export async function deleteSpotifyAccount(accountId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/spotify/accounts/${encodeURIComponent(accountId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to remove Spotify account');
  }
}

export type SpotifyBridgeConfig = {
  id: string;
  label: string;
  provider: string;
  enabled?: boolean;
  host?: string;
  port?: number;
  apiKey?: string;
  developerToken?: string;
  userToken?: string;
  deezerArl?: string;
  tidalAccessToken?: string;
  tidalCountryCode?: string;
  registerAll?: boolean;
};

export type CreateSpotifyBridgePayload = {
  provider: string;
  host?: string;
  port?: number;
  apiKey?: string;
  developerToken?: string;
  userToken?: string;
  deezerArl?: string;
  tidalAccessToken?: string;
  tidalCountryCode?: string;
  registerAll?: boolean;
};

export async function createSpotifyBridge(payload: CreateSpotifyBridgePayload): Promise<{ bridge: SpotifyBridgeConfig }> {
  const res = await fetch(`${API_BASE}/spotify/bridges`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to add bridge');
  }
  return (await res.json()) as { bridge: SpotifyBridgeConfig };
}

export async function deleteSpotifyBridge(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/spotify/bridges/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to remove bridge');
  }
}

export type CustomRadioEntry = {
  id: string;
  name: string;
  stream: string;
  coverurl?: string;
};

type CustomRadioListResponse = {
  stations?: CustomRadioEntry[];
};

export async function fetchCustomRadioStations(): Promise<CustomRadioListResponse> {
  const res = await fetch(`${API_BASE}/content/radio/custom`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to load custom stations');
  }
  return (await res.json()) as CustomRadioListResponse;
}

export async function createCustomRadioStation(payload: {
  name: string;
  stream: string;
  coverurl?: string;
}): Promise<CustomRadioEntry> {
  const res = await fetch(`${API_BASE}/content/radio/custom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to add custom station');
  }
  const data = (await res.json()) as { station: CustomRadioEntry };
  return data.station;
}

export async function deleteCustomRadioStation(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/content/radio/custom/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to remove custom station');
  }
}

export type LibraryStorage = {
  id: string;
  name: string;
  server: string;
  folder: string;
  type: string;
  username?: string;
  password?: string;
  guest?: boolean;
};

type LibraryStorageListResponse = {
  storages?: LibraryStorage[];
};

export async function fetchLibraryStorages(): Promise<LibraryStorageListResponse> {
  const res = await fetch(`${API_BASE}/content/library/storages`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to load library shares');
  }
  return (await res.json()) as LibraryStorageListResponse;
}

export type CreateLibraryStoragePayload = {
  name: string;
  server: string;
  folder: string;
  type: string;
  username?: string;
  password?: string;
  guest?: boolean;
  id?: string;
};

type CreateLibraryStorageResponse = {
  storage: LibraryStorage;
};

export async function createLibraryStorage(
  payload: CreateLibraryStoragePayload,
): Promise<CreateLibraryStorageResponse> {
  const res = await fetch(`${API_BASE}/content/library/storages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to add library share');
  }
  return (await res.json()) as CreateLibraryStorageResponse;
}
