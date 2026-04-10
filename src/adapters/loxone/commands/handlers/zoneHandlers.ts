import { buildEmptyResponse, buildResponse } from '@/adapters/loxone/commands/responses';
import type { ContentManager } from '@/adapters/content/contentManager';
import {
  decodeSegment,
  extractPayload,
  parseNumberPart,
  splitCommand,
} from '@/adapters/loxone/commands/utils/commandUtils';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { FavoritesManager } from '@/application/zones/favorites/favoritesManager';
import { decodeAudiopath } from '@/domain/loxone/audiopath';
import { fadeController } from '@/application/zones/fadeController';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';

export function createZoneHandlers(
  zoneManager: ZoneManagerFacade,
  recentsManager: RecentsManager,
  favoritesManager: FavoritesManager,
  contentManager: ContentManager,
) {
  return {
    audioGetStatus: (command: string) => audioGetStatus(zoneManager, command),
    audioCfgGetQueue: (command: string) => audioCfgGetQueue(zoneManager, command),
    audioRecent: (command: string) => audioRecent(recentsManager, command),
    audioPlaylistPlay: (command: string) => audioPlaylistPlay(zoneManager, contentManager, command),
    audioLibraryPlay: (command: string) => audioLibraryPlay(zoneManager, contentManager, command),
    audioServicePlay: (command: string) => audioServicePlay(zoneManager, contentManager, command),
    audioPlayUrl: (command: string) => audioPlayUrl(zoneManager, contentManager, command),
    audioDynamicCommand: (command: string) => audioDynamicCommand(zoneManager, command),
    audioCfgGetRoomFavs: (command: string) => audioCfgGetRoomFavs(favoritesManager, command),
    audioCfgRoomFavs: (command: string) => audioCfgRoomFavs(favoritesManager, command),
    audioFavoritePlay: (command: string) =>
      audioFavoritePlay(zoneManager, favoritesManager, command),
    audioRoomFavPlus: (command: string) =>
      audioRoomFavPlus(zoneManager, favoritesManager, command),
  };
}

function audioGetStatus(zoneManager: ZoneManagerFacade, command: string) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const state = zoneManager.getState(zoneId);
  return buildResponse(command, 'status', state ? [state] : []);
}

function audioCfgGetQueue(zoneManager: ZoneManagerFacade, command: string) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const start = parseNumberPart(parts[3], 0);
  const limit = parseNumberPart(parts[4], 50);

  const queue = zoneManager.getQueue(zoneId, start, limit);
  return buildResponse(command, 'getqueue', [
    {
      id: queue.id,
      items: queue.items,
      shuffle: queue.shuffle,
      start: queue.start,
      totalitems: queue.totalitems,
    },
  ]);
}

async function audioRecent(recentsManager: RecentsManager, command: string) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const recents = await recentsManager.get(zoneId);
  return buildResponse(command, 'recent', recents ?? {});
}

async function audioPlaylistPlay(
  zoneManager: ZoneManagerFacade,
  contentManager: ContentManager,
  command: string,
) {
  return playToZone(zoneManager, contentManager, command, 'playlistplay', (parts) =>
    extractPayload(parts.slice(4)),
  );
}

async function audioLibraryPlay(
  zoneManager: ZoneManagerFacade,
  contentManager: ContentManager,
  command: string,
) {
  return playToZone(zoneManager, contentManager, command, 'libraryplay', (parts) =>
    extractPayload(parts.slice(4)),
  );
}

/**
 * Maps a Loxone parentid folder reference to a Spotify audiopath with provider prefix.
 * Loxone sends parentid/<folderId>/<trackIndex> when clicking a track from a browsed folder.
 * folderId is either a numeric category (e.g. 4 = Liked Songs) or a full Spotify URI.
 * Returns null if the folder has no single playable context (e.g. "all playlists" list).
 */
function folderIdToSpotifyAudiopath(folderId: string, providerPrefix: string): string | null {
  const key = folderId.toLowerCase();
  if (key === '4' || key === 'liked' || key.includes('liked-songs') || key === 'user:collection') {
    return `${providerPrefix}:user:collection`;
  }
  if (key.startsWith('spotify:playlist:') || key.startsWith('playlist:')) {
    return `${providerPrefix}:playlist:${folderId.split(':').pop()}`;
  }
  if (key.startsWith('spotify:album:') || key.startsWith('album:')) {
    return `${providerPrefix}:album:${folderId.split(':').pop()}`;
  }
  if (key.startsWith('spotify:artist:') || key.startsWith('artist:')) {
    return `${providerPrefix}:artist:${folderId.split(':').pop()}`;
  }
  if (key.startsWith('spotify:show:') || key.startsWith('show:')) {
    return `${providerPrefix}:show:${folderId.split(':').pop()}`;
  }
  return null;
}

function resolveParentIdInCommand(command: string): string {
  // /parentid/<folderId>/<trackIndex> — folderId may contain colons but not slashes
  const match = /\/parentid\/([^/]+)\/(\d+)/.exec(command);
  if (!match) return command;
  const folderId = match[1];
  const trackIndex = match[2];
  // Derive provider prefix from command: audio/{zoneId}/serviceplay/{service}/{user}/...
  const parts = command.split('/');
  const service = parts[3] ?? 'spotify';
  const rawUser = parts[4] ?? '';
  const user = rawUser && rawUser !== 'nouser' ? rawUser : '';
  const providerPrefix = user ? `${service}@${user}` : service;
  const audiopath = folderIdToSpotifyAudiopath(folderId, providerPrefix);
  if (!audiopath) return command;
  return command.replace(match[0], `/parentpath/${audiopath}/${trackIndex}`);
}

async function audioServicePlay(
  zoneManager: ZoneManagerFacade,
  contentManager: ContentManager,
  command: string,
) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const hasNoShuffle = /\/noshuffle(?:\/|$)/i.test(command);
  zoneManager.setPendingShuffle(zoneId, !hasNoShuffle);
  const resolvedCommand = resolveParentIdInCommand(command);
  const response = await playToZone(zoneManager, contentManager, resolvedCommand, 'serviceplay', (parts) => {
    const decoded = extractPayload(parts.slice(4));
    const withoutNouser = decoded.startsWith('nouser/')
      ? decoded.slice('nouser/'.length)
      : decoded;

    const slashIndex = withoutNouser.indexOf('/');
    if (slashIndex > 0) {
      const maybeUser = withoutNouser.slice(0, slashIndex);
      const rest = withoutNouser.slice(slashIndex + 1);
      if (rest.startsWith('spotify@') || rest.startsWith('spotify:')) {
        if (
          rest.startsWith('spotify:') &&
          maybeUser &&
          (/applemusic/i.test(maybeUser) || /deezer/i.test(maybeUser) || /tidal/i.test(maybeUser))
        ) {
          return `spotify@${maybeUser}:${rest.replace(/^spotify:/i, '')}`;
        }
        return rest;
      }
      return `${maybeUser}/${rest}`;
    }

    return withoutNouser;
  });
  return response;
}

async function audioPlayUrl(
  zoneManager: ZoneManagerFacade,
  contentManager: ContentManager,
  command: string,
) {
  return playToZone(zoneManager, contentManager, command, 'playurl', (parts) =>
    extractPayload(parts.slice(3)),
  );
}

function audioDynamicCommand(zoneManager: ZoneManagerFacade, command: string) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const cmd = (parts[2] ?? '').toLowerCase();
  const payload = parts.slice(3).join('/');
  zoneManager.handleCommand(zoneId, cmd, payload);
  return buildEmptyResponse(command);
}

async function audioCfgGetRoomFavs(
  favoritesManager: FavoritesManager,
  command: string,
) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[3], 0);
  const start = parseNumberPart(parts[4], 0);
  const limit = parseNumberPart(parts[5], 50);
  const favorites = await favoritesManager.get(zoneId, start, limit);
  return buildResponse(command, 'getroomfavs', [favorites]);
}

async function audioCfgRoomFavs(
  favoritesManager: FavoritesManager,
  command: string,
) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[3], 0);
  const action = (parts[4] ?? '').toLowerCase();
  const rest = parts.slice(5);

  switch (action) {
    case 'add': {
      const title = decodeSegment(rest[0] ?? '');
      const source = decodeSegment(rest.slice(1).join('/'));
      const fav = await favoritesManager.add(zoneId, title, source);
      return buildResponse(command, 'roomfavs_add', { id: fav.id, name: title });
    }
    case 'setid': {
      const oldId = parseNumberPart(rest[0], 0);
      const newId = parseNumberPart(rest[1], 0);
      await favoritesManager.setId(zoneId, oldId, newId);
      return buildResponse(command, 'roomfavs_set', { changed_from: oldId, changed_to: newId });
    }
    case 'delete': {
      const id = parseNumberPart(rest[0], 0);
      await favoritesManager.remove(zoneId, id);
      return buildResponse(command, 'roomfavs_delete', { delete_id: id });
    }
    case 'reorder': {
      const order =
        rest[0]?.split(',').map((value) => Number(value)).filter(Boolean) ?? [];
      await favoritesManager.reorder(zoneId, order);
      return buildResponse(command, 'roomfavs_reorder', 'ok');
    }
    case 'copy': {
      const destinations =
        rest[0]?.split(',').map((value) => Number(value)).filter(Boolean) ?? [];
      await favoritesManager.copy(zoneId, destinations);
      return buildResponse(command, 'roomfavs_copy', 'ok');
    }
    default:
      return buildResponse(command, 'roomfavs_error', {});
  }
}

async function audioFavoritePlay(
  zoneManager: ZoneManagerFacade,
  favoritesManager: FavoritesManager,
  command: string,
) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const favoriteId = parseNumberPart(parts[4], 0);
  const fadeOpts = fadeController.parseFadeOptions(command);
  await playFavorite(zoneManager, favoritesManager, zoneId, favoriteId);
  if (fadeOpts.fade) {
    const duration = fadeOpts.fadeDurationMs ?? 120_000;
    void fadeController.fadeIn(zoneId, duration);
  }
  return buildResponse(command, 'roomfav', [{ playerid: zoneId, playing_slot: favoriteId }]);
}

async function audioRoomFavPlus(
  zoneManager: ZoneManagerFacade,
  favoritesManager: FavoritesManager,
  command: string,
) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const favorites = await favoritesManager.get(zoneId);
  if (!favorites.items.length) {
    return buildEmptyResponse(command);
  }

  const metadata = zoneManager.getMetadata(zoneId);
  if (!metadata) {
    return buildEmptyResponse(command);
  }
  const state = zoneManager.getState(zoneId);

  const lastFavoriteId = metadata.lastFavoriteId as number | undefined;
  let currentIndex = -1;

  if (typeof lastFavoriteId === 'number') {
    currentIndex = favorites.items.findIndex((item) => item.id === lastFavoriteId);
  } else if (state?.audiopath) {
    currentIndex = favorites.items.findIndex(
      (item) => item.audiopath === state.audiopath,
    );
  }

  const nextIndex =
    currentIndex >= 0
      ? (currentIndex + 1) % favorites.items.length
      : 0;

  const next = favorites.items[nextIndex];
  if (next) {
    await playFavorite(zoneManager, favoritesManager, zoneId, next.id);
    metadata.lastFavoriteId = next.id;
  }

  return buildEmptyResponse(command);
}

async function playFavorite(
  zoneManager: ZoneManagerFacade,
  favoritesManager: FavoritesManager,
  zoneId: number,
  favoriteId: number,
): Promise<void> {
  const favorite = await favoritesManager.getForPlayback(zoneId, favoriteId);
  if (!favorite) {
    return;
  }
  const favoriteMetadata = {
    title: favorite.title ?? favorite.name ?? '',
    artist: favorite.artist ?? '',
    album: favorite.album ?? '',
    coverurl: favorite.coverurl ?? '',
  };
  void zoneManager.playContent(zoneId, favorite.audiopath, 'favorite', favoriteMetadata);
  const ctxMetadata = zoneManager.getMetadata(zoneId);
  if (ctxMetadata) {
    ctxMetadata.lastFavoriteId = favoriteId;
  }
}

async function playToZone(
  zoneManager: ZoneManagerFacade,
  contentManager: ContentManager,
  command: string,
  name: string,
  payloadResolver: (parts: string[]) => string,
) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const uri = payloadResolver(parts);
  const fadeOpts = fadeController.parseFadeOptions(command);

  // Detect queue item clicks (no parent context) and pre-seek within the existing queue.
  const looksLikeQueueClick = uri && !uri.includes('/parentpath/') && !uri.includes('/parentid/');
  if (looksLikeQueueClick) {
    const candidates = [uri, decodeAudiopath(uri)].filter(Boolean);
    for (const target of candidates) {
      if (zoneManager.seekInQueue(zoneId, target)) {
        break;
      }
    }
  }

  const metadataTarget = sanitizeMetadataTarget(uri);
  const metadata = await contentManager.resolveMetadata(metadataTarget);
  void zoneManager.playContent(zoneId, uri, name, metadata ?? undefined);
  if (fadeOpts.fade) {
    const duration = fadeOpts.fadeDurationMs ?? 120_000;
    void fadeController.fadeIn(zoneId, duration);
  }
  return buildResponse(command, name, [{ zoneId, uri }]);
}

function sanitizeMetadataTarget(uri: string): string {
  if (!uri) {
    return uri;
  }
  const cleaned = uri
    .replace(/\/parentpath\/.*$/i, '')
    .replace(/\/parentid\/.*$/i, '')
    .replace(/\/noshuffle.*$/i, '')
    .replace(/\/\?q&ZW5mb3JjZVVzZXI9dHJ1ZQ.*$/i, '')
    .replace(/\/\?q&[A-Za-z0-9+/=]+$/i, '')
    .replace(/\/+$/, '');
  return decodeAudiopath(cleaned);
}
