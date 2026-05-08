const DEFAULT_SPOTIFY_CLIENT_ID = '26faeb2006ba44ed89ac34f9344670e2';

type ClientIdSource =
  | {
      clientId?: string | null;
    }
  | {
      client_id?: string | null;
    }
  | null
  | undefined;

/**
 * Resolve the Spotify client id while falling back to the default public id.
 */
export function resolveSpotifyClientId(source?: ClientIdSource): string {
  if (source) {
    const src = source as { clientId?: string | null; client_id?: string | null };
    const raw =
      typeof src.clientId === 'string'
        ? src.clientId
        : typeof src.client_id === 'string'
          ? src.client_id
          : undefined;

    if (raw && raw.trim()) {
      return raw.trim();
    }
  }

  return DEFAULT_SPOTIFY_CLIENT_ID;
}

export { DEFAULT_SPOTIFY_CLIENT_ID };
