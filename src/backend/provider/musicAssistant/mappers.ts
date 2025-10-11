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
  const cover = resolveArtwork(album, [album?.coverurl, album?.thumbnail, album?.image]);

  return {
    id: key,
    name,
    cmd: key,
    type: FileType.Folder,
    coverurl: cover,
    thumbnail: cover,
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
  const cover = resolveArtwork(artist, [artist?.coverurl, artist?.thumbnail, artist?.image]);

  return {
    id: key,
    name: extractName(artist) ?? rawId,
    cmd: key,
    type: FileType.Folder,
    coverurl: cover,
    thumbnail: cover,
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
  if (albumContext) {
    const albumRawId =
      extractItemId(albumContext) ??
      extractUri(albumContext) ??
      extractName(albumContext) ??
      '';
    playlistName = extractName(albumContext) ?? albumRawId;
    playlistCover = resolveArtwork(albumContext, [albumContext?.coverurl, albumContext?.thumbnail, albumContext?.image]);
    playlistCommandUri =
      normalizeMediaUri(
        extractUri(albumContext, 'album', albumRawId, provider) ??
          buildLibraryUri('album', albumRawId, provider),
      );
  }

  const trackCover = resolveArtwork(track, [track?.coverurl, track?.thumbnail, track?.image]);
  const cover = trackCover || playlistCover;

  return {
    id: key,
    name,
    cmd: key,
    type: FileType.File,
    audiopath: uri,
    coverurl: cover ?? '',
    thumbnail: cover,
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
  let playlistProviderInstanceId: string | undefined;

  if (playlistContext) {
    const playlistRawId =
      extractItemId(playlistContext) ??
      extractUri(playlistContext) ??
      extractName(playlistContext) ??
      '';
    playlistName = extractName(playlistContext) ?? playlistRawId;
    playlistCover = resolveArtwork(playlistContext, [
      playlistContext?.playlistCover,
      playlistContext?.coverurl,
      playlistContext?.thumbnail,
      playlistContext?.image,
    ]);
    playlistProviderInstanceId = extractProvider(playlistContext) ?? provider;
    const rawPlaylistUri =
      extractUri(playlistContext, 'playlist', playlistRawId, playlistProviderInstanceId) ??
      buildPlaylistUri(playlistRawId, playlistProviderInstanceId);
    playlistCommandUri = toPlaylistCommandUri(rawPlaylistUri, playlistProviderInstanceId, playlistRawId);
  }

  const trackCover = resolveArtwork(track, [track?.coverurl, track?.thumbnail, track?.image]);
  const cover = trackCover || playlistCover;

  if (!playlistProviderInstanceId) {
    playlistProviderInstanceId = provider;
  }

  return {
    id: key,
    name,
    audiopath: uri,
    coverurl: cover ?? '',
    thumbnail: cover,
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
    playlistCover: playlistCover ?? cover,
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
  const cover = resolveArtwork(playlist, [playlist?.playlistCover, playlist?.coverurl, playlist?.thumbnail, playlist?.image]);

  return {
    id: buildPlaylistKey(provider, rawId),
    name,
    audiopath: uri,
    coverurl: cover,
    thumbnail: cover,
    type: FileType.PlaylistEditable,
    provider,
    providerInstanceId: provider,
    rawId,
    items: safeNumber(playlist?.track_count ?? playlist?.items?.length),
    playlistId: uri,
    playlistName: name,
    playlistCover: cover,
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

  const cover = resolveArtwork(radio, [radio?.coverurl, radio?.thumbnail, radio?.image]);

  return {
    id: buildRadioKey(provider, rawId, fallbackProvider),
    name,
    station: uri,
    audiopath: uri,
    coverurl: cover,
    sort: 'alpha',
    type: FileType.Playlist,
    provider,
  };
}

function resolveArtwork(item: any, additional: Array<string | undefined> = []): string {
  const candidates = new Set<string>();
  const add = (value?: string) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed) return;
    candidates.add(trimmed);
  };

  add(extractImage(item));

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
  for (const field of directFields) add(item?.[field]);

  const metadata = item?.metadata;
  if (metadata && typeof metadata === 'object') {
    add(metadata.image);
    add(metadata.cover);
    add(metadata.thumbnail);
    add(metadata.icon);
    const metadataImages = Array.isArray(metadata.images) ? metadata.images : [];
    for (const entry of metadataImages) {
      if (typeof entry === 'string') {
        add(entry);
      } else if (entry && typeof entry === 'object') {
        add(entry.path);
        add(entry.url);
        add(entry.href);
        add(entry.link);
        add(entry.src);
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
      add(field);
      continue;
    }
    if (Array.isArray(field)) {
      for (const entry of field) {
        if (typeof entry === 'string') {
          add(entry);
        } else if (entry && typeof entry === 'object') {
          add(entry.path);
          add(entry.url);
          add(entry.href);
          add(entry.link);
          add(entry.src);
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
  providerCandidates.forEach(add);

  additional.forEach(add);

  for (const candidate of candidates) {
    const normalized = toMusicAssistantImageUrl(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function toMusicAssistantImageUrl(value?: string, provider = 'builtin'): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
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
  const providerParam = encodeURIComponent(provider);
  return `${musicAssistantBaseUrl}/imageproxy?path=${encodedTwice}&provider=${providerParam}&checksum=&size=256`;
}
