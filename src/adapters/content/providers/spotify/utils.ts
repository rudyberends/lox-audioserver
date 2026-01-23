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
    const raw =
      typeof (source as any).clientId === 'string'
        ? (source as any).clientId
        : typeof (source as any).client_id === 'string'
          ? (source as any).client_id
          : undefined;

    if (raw && raw.trim()) {
      return raw.trim();
    }
  }

  return DEFAULT_SPOTIFY_CLIENT_ID;
}

export { DEFAULT_SPOTIFY_CLIENT_ID };
