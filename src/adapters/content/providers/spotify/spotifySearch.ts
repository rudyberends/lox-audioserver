import type { ContentFolderItem } from '@/ports/ContentTypes';
import type { ProviderSearchResult } from '@/adapters/content/ContentProvider';
import type { SpotifyAccountProvider } from '@/adapters/content/providers/spotify/spotifyAccountProvider';

const SPOTIFY_SEARCH_MAX_LIMIT = 10;

/**
 * Search one Spotify account: pathfinder first, the Web API when it cannot answer.
 *
 * Lived in the service manager, which meant the manager knew how to read Spotify's search
 * JSON while every other service kept that knowledge to itself. Here it sits next to the
 * account it belongs to, and Spotify implements the same `search()` as the rest.
 */
export async function searchSpotifyAccount(
  provider: SpotifyAccountProvider,
  query: string,
  limits: Record<string, number>,
  maxLimit: number,
): Promise<ProviderSearchResult> {
  // Primary path: pathfinder search (track/album/artist/playlist). Falls back
  // to the Web API below when pathfinder is unavailable.
  const pf = await provider.searchPathfinder(query, limits, maxLimit);
  if (pf && Object.keys(pf.result).length) {
    const merged: Record<string, ContentFolderItem[]> & { _totals?: Record<string, number> } = pf.result;
    merged._totals = pf.totals;
    return { result: merged, user: provider.accountId, providerId: provider.providerId };
  }

  const accessToken = await provider.fetchAccessToken();
  if (!accessToken) {
    return {
      result: {},
      user: provider.accountId,
      providerId: provider.providerId,
    };
  }

  const supportedTypes = ['track', 'album', 'artist', 'playlist', 'episode', 'show'] as const;
  const requestedTypes = Object.keys(limits);
  const activeTypes =
    requestedTypes.length > 0
      ? supportedTypes.filter((t) => requestedTypes.includes(t))
      : supportedTypes;
  if (!activeTypes.length) {
    return { result: {}, user: provider.accountId, providerId: provider.providerId };
  }

  const url = new URL('https://api.spotify.com/v1/search');
  url.searchParams.set('q', query.replace(/'/g, ''));
  url.searchParams.set('type', activeTypes.join(','));
  const safeSearchLimit = Math.min(Math.max(maxLimit || 20, 1), SPOTIFY_SEARCH_MAX_LIMIT);
  url.searchParams.set('limit', String(safeSearchLimit));

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    return { result: {}, user: provider.accountId, providerId: provider.providerId };
  }
  const data = (await res.json()) as Record<string, any> | null;
  const result: Record<string, ContentFolderItem[]> & { _totals?: Record<string, number> } = {};
  const totals: Record<string, number> = {};
  const providerPrefix = provider.providerId;

  const mapTrack = (track: any): ContentFolderItem | null => {
    const id = String(track?.id ?? '');
    if (!id) return null;
    const name = String(track?.name ?? id);
    const artists = Array.isArray(track?.artists)
      ? track.artists
          .map((a: { name?: unknown } | null) => (a && typeof a.name === 'string' ? a.name : ''))
          .filter(Boolean)
          .join(', ')
      : '';
    const album = track?.album?.name ?? '';
    const cover =
      (Array.isArray(track?.album?.images) && track.album.images[0]?.url) || '';
    return {
      id: `${providerPrefix}:track:${id}`,
      title: name,
      name,
      audiopath: `${providerPrefix}:track:${id}`,
      coverurl: cover,
      thumbnail: cover,
      artist: artists,
      album,
      duration: typeof track?.duration_ms === 'number' ? Math.round(track.duration_ms / 1000) : undefined,
      hasCover: !!cover,
      owner: album || undefined,
      type: 2,
      tag: 'track',
    };
  };

  const mapAlbum = (album: any): ContentFolderItem | null => {
    const id = String(album?.id ?? '');
    if (!id) return null;
    const name = String(album?.name ?? id);
    const cover = (Array.isArray(album?.images) && album.images[0]?.url) || '';
    const artists = Array.isArray(album?.artists)
      ? album.artists
          .map((a: { name?: unknown } | null) => (a && typeof a.name === 'string' ? a.name : ''))
          .filter(Boolean)
          .join(', ')
      : '';
    return {
      id: `${providerPrefix}:album:${id}`,
      title: name,
      name,
      audiopath: `${providerPrefix}:album:${id}`,
      coverurl: cover,
      thumbnail: cover,
      artist: artists,
      type: 7,
      tag: 'album',
    };
  };

  const mapArtist = (artist: any): ContentFolderItem | null => {
    const id = String(artist?.id ?? '');
    if (!id) return null;
    const name = String(artist?.name ?? id);
    const cover = (Array.isArray(artist?.images) && artist.images[0]?.url) || '';
    return {
      id: `${providerPrefix}:artist:${id}`,
      title: name,
      name,
      audiopath: `${providerPrefix}:artist:${id}`,
      coverurl: cover,
      thumbnail: cover,
      artist: name,
      type: 7,
      tag: 'artist',
    };
  };

  const mapPlaylist = (playlist: any): ContentFolderItem | null => {
    const id = String(playlist?.id ?? '');
    if (!id) return null;
    const name = String(playlist?.name ?? id);
    const cover = (Array.isArray(playlist?.images) && playlist.images[0]?.url) || '';
    return {
      id: `${providerPrefix}:playlist:${id}`,
      title: name,
      name,
      audiopath: `${providerPrefix}:playlist:${id}`,
      coverurl: cover,
      thumbnail: cover,
      artist: '',
      owner: playlist?.owner?.display_name || playlist?.owner?.id || '',
      owner_id: playlist?.owner?.id || '',
      type: 7,
      tag: 'playlist',
    };
  };

  const mapShow = (show: any): ContentFolderItem | null => {
    const id = String(show?.id ?? '');
    if (!id) return null;
    const name = String(show?.name ?? id);
    const publisher = show?.publisher ?? '';
    const cover = (Array.isArray(show?.images) && show.images[0]?.url) || '';
    return {
      id: `${providerPrefix}:show:${id}`,
      title: name,
      name,
      audiopath: `${providerPrefix}:show:${id}`,
      coverurl: cover,
      thumbnail: cover,
      artist: publisher,
      type: 7,
      tag: 'show',
    };
  };

  const mapEpisode = (episode: any): ContentFolderItem | null => {
    const id = String(episode?.id ?? '');
    if (!id) return null;
    const name = String(episode?.name ?? id);
    const showName = episode?.show?.name ?? '';
    const cover =
      (Array.isArray(episode?.images) && episode.images[0]?.url) ||
      (Array.isArray(episode?.show?.images) && episode.show.images[0]?.url) ||
      '';
    return {
      id: `${providerPrefix}:episode:${id}`,
      title: name,
      name,
      audiopath: `${providerPrefix}:episode:${id}`,
      coverurl: cover,
      thumbnail: cover,
      artist: showName,
      album: showName,
      type: 2,
      tag: 'episode',
    };
  };

  if (activeTypes.includes('track') && data?.tracks?.items) {
    const max = limits.track ?? maxLimit;
    const items = Array.isArray(data.tracks.items) ? data.tracks.items : [];
    result.tracks = items.slice(0, max).map(mapTrack).filter(Boolean) as ContentFolderItem[];
    totals.tracks = typeof data.tracks.total === 'number' ? data.tracks.total : items.length;
  }
  if (activeTypes.includes('album') && data?.albums?.items) {
    const max = limits.album ?? maxLimit;
    const items = Array.isArray(data.albums.items) ? data.albums.items : [];
    result.albums = items.slice(0, max).map(mapAlbum).filter(Boolean) as ContentFolderItem[];
    totals.albums = typeof data.albums.total === 'number' ? data.albums.total : items.length;
  }
  if (activeTypes.includes('artist') && data?.artists?.items) {
    const max = limits.artist ?? maxLimit;
    const items = Array.isArray(data.artists.items) ? data.artists.items : [];
    result.artists = items.slice(0, max).map(mapArtist).filter(Boolean) as ContentFolderItem[];
    totals.artists = typeof data.artists.total === 'number' ? data.artists.total : items.length;
  }
  if (activeTypes.includes('playlist') && data?.playlists?.items) {
    const max = limits.playlist ?? maxLimit;
    const items = Array.isArray(data.playlists.items) ? data.playlists.items : [];
    result.playlists = items
      .slice(0, max)
      .map(mapPlaylist)
      .filter(Boolean) as ContentFolderItem[];
    totals.playlists =
      typeof data.playlists.total === 'number' ? data.playlists.total : items.length;
  }
  if (activeTypes.includes('show') && data?.shows?.items) {
    const max = limits.show ?? maxLimit;
    const items = Array.isArray(data.shows.items) ? data.shows.items : [];
    result.shows = items.slice(0, max).map(mapShow).filter(Boolean) as ContentFolderItem[];
    totals.shows = typeof data.shows.total === 'number' ? data.shows.total : items.length;
  }
  if (activeTypes.includes('episode') && data?.episodes?.items) {
    const max = limits.episode ?? maxLimit;
    const items = Array.isArray(data.episodes.items) ? data.episodes.items : [];
    result.episodes = items
      .slice(0, max)
      .map(mapEpisode)
      .filter(Boolean) as ContentFolderItem[];
    totals.episodes =
      typeof data.episodes.total === 'number' ? data.episodes.total : items.length;
  }

  result._totals = totals;

  return { result, user: provider.accountId, providerId: provider.providerId };
}
