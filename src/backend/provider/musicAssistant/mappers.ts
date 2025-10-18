import { FileType } from '../../zone/loxoneTypes';
import {
  buildLibraryKey,
  buildLibraryUri,
  buildPlaylistKey,
  buildPlaylistUri,
  buildRadioKey,
  extractAlbum,
  extractArtist,
  extractImage,
  extractItemId,
  extractName,
  extractProvider,
  extractUri,
  normalizeMediaUri,
  toPlaylistCommandUri,
  safeNumber,
} from './utils';
import { MediaFolderItem, PlaylistItem, RadioFolderItem } from '../types';

let musicAssistantBaseUrl = '';
const LOCAL_LIBRARY_ORIGIN_NAS = 1;
const DEFAULT_THUMBNAIL_SIZE = 0;
const DEFAULT_COVER_SIZE = 512;
const DEFAULT_PLAYBACK_COVER_SIZE = 1024;

export function setMusicAssistantBaseUrl(host: string, port: number): void {
  musicAssistantBaseUrl = `http://${host}:${port}`;
}

export function mapAlbumToFolderItem(
  album: any,
  fallbackProvider: string,
): MediaFolderItem {
  const provider = extractProvider(album) ?? fallbackProvider;
  const rawId = extractItemId(album) ?? extractName(album) ?? '';
  const uri = normalizeMediaUri(
    extractUri(album, 'album', rawId, provider) ?? buildLibraryUri('album', rawId, provider),
  );
  const key = buildLibraryKey('album', provider, rawId, fallbackProvider);
  const name = extractName(album) ?? rawId;
  const artworkSource = selectArtworkCandidate(album, [album?.coverurl, album?.thumbnail, album?.image]);
  const coverHighRes = buildArtworkUrl(artworkSource, provider, DEFAULT_PLAYBACK_COVER_SIZE);
  const cover = buildArtworkUrl(artworkSource, provider, DEFAULT_COVER_SIZE);
  const thumbnail = buildArtworkUrl(artworkSource, provider, DEFAULT_THUMBNAIL_SIZE);
  const finalCover = cover || thumbnail || coverHighRes || '';
  const finalThumbnail = thumbnail || cover || coverHighRes || '';
  const finalHighRes = coverHighRes || cover || thumbnail || '';

  return {
    id: key,
    name,
    cmd: key,
    type: FileType.Folder,
    coverurl: finalCover,
    thumbnail: finalThumbnail,
    coverurlHighRes: finalHighRes,
    audiopath: uri,
    items: safeNumber(album?.track_count),
    album: name,
    artist: extractArtist(album) ?? undefined,
    tag: 'album',
    nas: true,
    origin: LOCAL_LIBRARY_ORIGIN_NAS,
  };
}

export function mapArtistToFolderItem(
  artist: any,
  fallbackProvider: string,
): MediaFolderItem {
  const provider = extractProvider(artist) ?? fallbackProvider;
  const rawId = extractItemId(artist) ?? extractName(artist) ?? '';
  const uri = normalizeMediaUri(
    extractUri(artist, 'artist', rawId, provider) ?? buildLibraryUri('artist', rawId, provider),
  );
  const key = buildLibraryKey('artist', provider, rawId, fallbackProvider);
  const artworkSource = selectArtworkCandidate(artist, [artist?.coverurl, artist?.thumbnail, artist?.image]);
  const coverHighRes = buildArtworkUrl(artworkSource, provider, DEFAULT_PLAYBACK_COVER_SIZE);
  const cover = buildArtworkUrl(artworkSource, provider, DEFAULT_COVER_SIZE);
  const thumbnail = buildArtworkUrl(artworkSource, provider, DEFAULT_THUMBNAIL_SIZE);
  const finalCover = cover || thumbnail || coverHighRes || '';
  const finalThumbnail = thumbnail || cover || coverHighRes || '';
  const finalHighRes = coverHighRes || cover || thumbnail || '';

  return {
    id: key,
    name: extractName(artist) ?? rawId,
    cmd: key,
    type: FileType.Folder,
    coverurl: finalCover,
    thumbnail: finalThumbnail,
    coverurlHighRes: finalHighRes,
    audiopath: uri,
    artist: extractArtist(artist) ?? extractName(artist) ?? undefined,
    tag: 'artist',
    nas: true,
    origin: LOCAL_LIBRARY_ORIGIN_NAS,
  };
}

export function mapTrackToMediaItem(
  track: any,
  fallbackProvider: string,
  providerOverride?: string,
  albumContext?: any,
): MediaFolderItem {
  const provider = providerOverride ?? extractProvider(track) ?? fallbackProvider;
  const rawId = extractItemId(track) ?? extractUri(track) ?? extractName(track) ?? '';
  const name = extractName(track) ?? rawId;
  const uri = normalizeMediaUri(
    extractUri(track, 'track', rawId, provider) ?? buildLibraryUri('track', rawId, provider),
  );
  const key = buildLibraryKey('track', provider, rawId, fallbackProvider);

  let playlistCommandUri: string | undefined;
  let playlistName: string | undefined;
  let playlistCover: string | undefined;
  let playlistThumbnail: string | undefined;
  let playlistHighRes: string | undefined;
  if (albumContext) {
    const albumRawId =
      extractItemId(albumContext) ??
      extractUri(albumContext) ??
      extractName(albumContext) ??
      '';
    playlistName = extractName(albumContext) ?? albumRawId;
    const albumArtworkSource = selectArtworkCandidate(albumContext, [
      albumContext?.coverurl,
      albumContext?.thumbnail,
      albumContext?.image,
    ]);
    playlistHighRes = buildArtworkUrl(albumArtworkSource, provider, DEFAULT_PLAYBACK_COVER_SIZE) || undefined;
    playlistCover = buildArtworkUrl(albumArtworkSource, provider, DEFAULT_COVER_SIZE) || playlistHighRes || undefined;
    playlistThumbnail =
      buildArtworkUrl(albumArtworkSource, provider, DEFAULT_THUMBNAIL_SIZE) ||
      playlistCover ||
      playlistHighRes;
    playlistCommandUri =
      normalizeMediaUri(
        extractUri(albumContext, 'album', albumRawId, provider) ??
          buildLibraryUri('album', albumRawId, provider),
      );
  }

  const trackArtworkSource = selectArtworkCandidate(track, [track?.coverurl, track?.thumbnail, track?.image]);
  const trackHighRes = buildArtworkUrl(trackArtworkSource, provider, DEFAULT_PLAYBACK_COVER_SIZE);
  const trackCover = buildArtworkUrl(trackArtworkSource, provider, DEFAULT_COVER_SIZE);
  const trackThumbnail = buildArtworkUrl(trackArtworkSource, provider, DEFAULT_THUMBNAIL_SIZE);
  const cover = trackCover || playlistCover || trackHighRes || playlistHighRes || '';
  const thumbnail = trackThumbnail || playlistThumbnail || trackCover || playlistCover || trackHighRes || playlistHighRes || '';
  const coverHighRes = trackHighRes || playlistHighRes || trackCover || playlistCover || trackThumbnail || playlistThumbnail || '';

  return {
    id: key,
    name,
    cmd: key,
    type: FileType.File,
    audiopath: uri,
    coverurl: cover,
    thumbnail,
    coverurlHighRes: coverHighRes,
    provider,
    rawId,
    album: extractAlbum(track) ?? extractName(albumContext) ?? undefined,
    artist: extractArtist(track) ?? undefined,
    duration: safeNumber(track?.duration) ?? undefined,
    title: name,
    tag: 'track',
    nas: true,
    origin: LOCAL_LIBRARY_ORIGIN_NAS,
    //playlistCommandUri,
    //playlistId: playlistCommandUri,
    //playlistName,
    //playlistCover: playlistCover ?? cover,
    //playlistProviderInstanceId: playlistCommandUri ? provider : undefined,
    //playlistStartItem: uri,
  };
}

export function mapTrackToPlaylistItem(
  track: any,
  fallbackProvider: string,
  providerOverride?: string,
  playlistContext?: any,
): PlaylistItem {
  const provider = providerOverride ?? extractProvider(track) ?? fallbackProvider;
  const rawId = extractItemId(track) ?? extractUri(track) ?? extractName(track) ?? '';
  const name = extractName(track) ?? rawId;
  const uri = normalizeMediaUri(
    extractUri(track, 'track', rawId, provider) ?? buildLibraryUri('track', rawId, provider),
  );
  const key = buildLibraryKey('track', provider, rawId, fallbackProvider);

  let playlistCommandUri: string | undefined;
  let playlistName: string | undefined;
  let playlistCover: string | undefined;
  let playlistThumbnail: string | undefined;
  let playlistHighRes: string | undefined;
  let playlistProviderInstanceId: string | undefined;

  if (playlistContext) {
    const playlistRawId =
      extractItemId(playlistContext) ??
      extractUri(playlistContext) ??
      extractName(playlistContext) ??
      '';
    playlistName = extractName(playlistContext) ?? playlistRawId;
    const inferredPlaylistProvider = extractProvider(playlistContext) ?? provider;
    const playlistArtworkSource = selectArtworkCandidate(playlistContext, [
      playlistContext?.playlistCover,
      playlistContext?.coverurl,
      playlistContext?.thumbnail,
      playlistContext?.image,
    ]);
    playlistHighRes =
      buildArtworkUrl(playlistArtworkSource, inferredPlaylistProvider, DEFAULT_PLAYBACK_COVER_SIZE) || undefined;
    playlistCover =
      buildArtworkUrl(playlistArtworkSource, inferredPlaylistProvider, DEFAULT_COVER_SIZE) ||
      playlistHighRes ||
      undefined;
    playlistThumbnail =
      buildArtworkUrl(playlistArtworkSource, inferredPlaylistProvider, DEFAULT_THUMBNAIL_SIZE) ||
      playlistCover ||
      playlistHighRes;
    playlistProviderInstanceId = inferredPlaylistProvider;
    const rawPlaylistUri =
      extractUri(playlistContext, 'playlist', playlistRawId, playlistProviderInstanceId) ??
      buildPlaylistUri(playlistRawId, playlistProviderInstanceId);
    playlistCommandUri = toPlaylistCommandUri(rawPlaylistUri, playlistProviderInstanceId, playlistRawId);
  }

  const trackArtworkSource = selectArtworkCandidate(track, [track?.coverurl, track?.thumbnail, track?.image]);
  const trackHighRes = buildArtworkUrl(trackArtworkSource, provider, DEFAULT_PLAYBACK_COVER_SIZE);
  const trackCover = buildArtworkUrl(trackArtworkSource, provider, DEFAULT_COVER_SIZE);
  const trackThumbnail = buildArtworkUrl(trackArtworkSource, provider, DEFAULT_THUMBNAIL_SIZE);
  const cover =
    trackCover || playlistCover || trackHighRes || playlistHighRes || trackThumbnail || playlistThumbnail || '';
  const thumbnail =
    trackThumbnail || playlistThumbnail || trackCover || playlistCover || trackHighRes || playlistHighRes || '';
  const coverHighRes =
    trackHighRes || playlistHighRes || trackCover || playlistCover || trackThumbnail || playlistThumbnail || '';

  if (!playlistProviderInstanceId) {
    playlistProviderInstanceId = provider;
  }

  return {
    id: key,
    name,
    audiopath: uri,
    coverurl: cover,
    thumbnail,
    coverurlHighRes: coverHighRes,
    type: FileType.File,
    provider,
    providerInstanceId: provider,
    rawId,
    album: extractAlbum(track) ?? undefined,
    artist: extractArtist(track) ?? undefined,
    title: name,
    uniqueId: key,
    playlistCommandUri,
    playlistId: playlistCommandUri,
    playlistName,
    playlistCover: playlistHighRes ?? playlistCover ?? cover,
    playlistProviderInstanceId,
    playlistStartItem: uri,
  };
}

export function mapPlaylistToItem(
  playlist: any,
  fallbackProvider: string,
): PlaylistItem {
  const provider = extractProvider(playlist) ?? fallbackProvider;
  const rawId = extractItemId(playlist) ?? extractUri(playlist) ?? extractName(playlist) ?? '';
  const rawUri =
    extractUri(playlist, 'playlist', rawId, provider) ??
    buildPlaylistUri(rawId, provider);
  const uri = toPlaylistCommandUri(rawUri, provider, rawId);
  const name = extractName(playlist) ?? rawId;
  const artworkSource = selectArtworkCandidate(playlist, [
    playlist?.playlistCover,
    playlist?.coverurl,
    playlist?.thumbnail,
    playlist?.image,
  ]);
  const coverHighRes = buildArtworkUrl(artworkSource, provider, DEFAULT_PLAYBACK_COVER_SIZE);
  const cover = buildArtworkUrl(artworkSource, provider, DEFAULT_COVER_SIZE);
  const thumbnail = buildArtworkUrl(artworkSource, provider, DEFAULT_THUMBNAIL_SIZE);
  const finalCover = cover || thumbnail || coverHighRes || '';
  const finalThumbnail = thumbnail || cover || coverHighRes || '';
  const finalHighRes = coverHighRes || cover || thumbnail || '';

  return {
    id: buildPlaylistKey(provider, rawId),
    name,
    audiopath: uri,
    coverurl: finalCover,
    thumbnail: finalThumbnail,
    coverurlHighRes: finalHighRes,
    type: FileType.PlaylistEditable,
    provider,
    providerInstanceId: provider,
    rawId,
    items: safeNumber(playlist?.track_count ?? playlist?.items?.length),
    playlistId: uri,
    playlistName: name,
    playlistCover: finalHighRes,
    playlistProviderInstanceId: provider,
    playlistCommandUri: uri,
  };
}

export function mapRadioToFolderItem(
  radio: any,
  fallbackProvider: string,
): RadioFolderItem | undefined {
  const provider = extractProvider(radio) ?? fallbackProvider;
  const rawId = extractItemId(radio) ?? extractUri(radio) ?? extractName(radio);
  const name = extractName(radio) ?? rawId;
  const uri = extractUri(radio, 'radio', rawId, provider);

  if (!rawId || !uri || !name) {
    return undefined;
  }

  const artworkSource = selectArtworkCandidate(radio, [radio?.coverurl, radio?.thumbnail, radio?.image]);
  const coverHighRes = buildArtworkUrl(artworkSource, provider, DEFAULT_PLAYBACK_COVER_SIZE);
  const cover = buildArtworkUrl(artworkSource, provider, DEFAULT_COVER_SIZE);
  const thumbnail = buildArtworkUrl(artworkSource, provider, DEFAULT_THUMBNAIL_SIZE);
  const finalCover = cover || thumbnail || coverHighRes || '';
  const finalThumbnail = thumbnail || cover || coverHighRes || '';
  const finalHighRes = coverHighRes || cover || thumbnail || '';

  return {
    id: buildRadioKey(provider, rawId, fallbackProvider),
    name,
    station: uri,
    audiopath: uri,
    coverurl: finalCover,
    thumbnail: finalThumbnail,
    coverurlHighRes: finalHighRes,
    sort: 'alpha',
    type: FileType.Playlist,
    provider,
  };
}

function selectArtworkCandidate(item: any, additional: Array<string | undefined> = []): string | undefined {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushCandidate = (value?: string) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  pushCandidate(extractImage(item));

  const directFields = [
    'image',
    'cover',
    'coverurl',
    'thumbnail',
    'thumb',
    'picture',
    'icon',
    'art',
    'artwork',
    'background',
    'logo',
    'poster',
  ];
  for (const field of directFields) pushCandidate(item?.[field]);

  const metadata = item?.metadata;
  if (metadata && typeof metadata === 'object') {
    pushCandidate(metadata.image);
    pushCandidate(metadata.cover);
    pushCandidate(metadata.thumbnail);
    pushCandidate(metadata.icon);
    const metadataImages = Array.isArray(metadata.images) ? metadata.images : [];
    for (const entry of metadataImages) {
      if (typeof entry === 'string') {
        pushCandidate(entry);
      } else if (entry && typeof entry === 'object') {
        pushCandidate(entry.path);
        pushCandidate(entry.url);
        pushCandidate(entry.href);
        pushCandidate(entry.link);
        pushCandidate(entry.src);
      }
    }
  }

  const arrayFields = [
    item?.images,
    item?.thumbnails,
    item?.covers,
    item?.media_images,
    item?.image_map,
    item?.thumbs,
    item?.icons,
    item?.artwork,
  ];
  for (const field of arrayFields) {
    if (!field) continue;
    if (typeof field === 'string') {
      pushCandidate(field);
    } else if (Array.isArray(field)) {
      for (const entry of field) {
        if (typeof entry === 'string') {
          pushCandidate(entry);
        } else if (entry && typeof entry === 'object') {
          pushCandidate(entry.path);
          pushCandidate(entry.url);
          pushCandidate(entry.href);
          pushCandidate(entry.link);
          pushCandidate(entry.src);
        }
      }
    }
  }

  const providerCandidates = [
    item?.provider?.image,
    item?.provider?.icon,
    item?.provider_mapping?.image,
    item?.provider_mapping?.icon,
    item?.providerMapping?.image,
    item?.providerMapping?.icon,
  ];
  providerCandidates.forEach(pushCandidate);

  additional.forEach(pushCandidate);

  return candidates[0];
}

function buildArtworkUrl(value?: string, provider?: string, size = DEFAULT_THUMBNAIL_SIZE): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) {
    return rewriteRemoteArtwork(trimmed, size);
  }
  if (trimmed.startsWith('media://')) {
    const rest = trimmed.slice('media://'.length).replace(/^\/+/, '');
    return `${musicAssistantBaseUrl}/media/${rest}`;
  }
  if (trimmed.startsWith('image://')) {
    const rest = trimmed.slice('image://'.length).replace(/^\/+/, '');
    return `${musicAssistantBaseUrl}/image/${rest}`;
  }
  const normalizedPath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const encodedOnce = encodeURIComponent(normalizedPath);
  const encodedTwice = encodeURIComponent(encodedOnce);
  const providerParam = encodeURIComponent(provider ?? 'builtin');
  return `${musicAssistantBaseUrl}/imageproxy?path=${encodedTwice}&provider=${providerParam}&checksum=&size=${size}`;
}

function rewriteRemoteArtwork(url: string, size: number): string {
  try {
    const parsed = new URL(url);
    const pathSegments = parsed.pathname.split('/');
    if (pathSegments.length > 0) {
      const last = pathSegments[pathSegments.length - 1];
      const match = last.match(/^(\d{2,4})x(\d{2,4})(.*)$/i);
      if (match) {
        const suffix = match[3] ?? '';
        pathSegments[pathSegments.length - 1] = `${size}x${size}${suffix}`;
        parsed.pathname = pathSegments.join('/');
        return parsed.toString();
      }
    }
  } catch {
    // fall through
  }
  return url;
}
