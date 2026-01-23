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

async function audioServicePlay(
  zoneManager: ZoneManagerFacade,
  contentManager: ContentManager,
  command: string,
) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const hasNoShuffle = /\/noshuffle(?:\/|$)/i.test(command);
  zoneManager.setPendingShuffle(zoneId, !hasNoShuffle);
  const response = await playToZone(zoneManager, contentManager, command, 'serviceplay', (parts) => {
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

  // Detect queue item clicks (no parentpath) and pre-seek within the existing queue.
  const looksLikeQueueClick = uri && !uri.includes('/parentpath/');
  if (looksLikeQueueClick) {
    const candidates = [uri, decodeAudiopath(uri)].filter(Boolean);
    for (const target of candidates) {
      if (zoneManager.seekInQueue(zoneId, target)) {
        break;
      }
    }
  }

  const sep = '/parentpath/';
  const metadataTarget =
    uri && uri.includes(sep) ? decodeAudiopath(uri.slice(0, uri.indexOf(sep))) : uri;
  const metadata = await contentManager.resolveMetadata(metadataTarget);
  void zoneManager.playContent(zoneId, uri, name, metadata ?? undefined);
  if (fadeOpts.fade) {
    const duration = fadeOpts.fadeDurationMs ?? 120_000;
    void fadeController.fadeIn(zoneId, duration);
  }
  return buildResponse(command, name, [{ zoneId, uri }]);
}
