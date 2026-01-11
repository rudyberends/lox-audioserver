import { buildEmptyResponse, buildResponse } from '@/modules/loxone/commands/responses';
import { zoneManager } from '@/modules/zones/zoneManager';
import { contentManager } from '@/modules/content/contentManager';
import {
  decodeSegment,
  extractPayload,
  parseNumberPart,
  splitCommand,
} from '@/modules/loxone/commands/utils/commandUtils';
import { recentsManager } from '@/modules/zones/recents/recentsManager';
import { favoritesManager } from '@/modules/zones/favorites/favoritesManager';
import { decodeAudiopath } from '@/modules/audio/utils/audiopath';
import { fadeController } from '@/modules/zones/fadeController';

export function audioGetStatus(command: string) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const state = zoneManager.getState(zoneId);
  return buildResponse(command, 'status', state ? [state] : []);
}

export function audioCfgGetQueue(command: string) {
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

export async function audioRecent(command: string) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const recents = await recentsManager.get(zoneId);
  return buildResponse(command, 'recent', recents ?? {});
}

export async function audioPlaylistPlay(command: string) {
  return playToZone(command, 'playlistplay', (parts) =>
    extractPayload(parts.slice(4)),
  );
}

export async function audioLibraryPlay(command: string) {
  return playToZone(command, 'libraryplay', (parts) =>
    extractPayload(parts.slice(4)),
  );
}

export async function audioServicePlay(command: string) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const hasNoShuffle = /\/noshuffle(?:\/|$)/i.test(command);
  zoneManager.setPendingShuffle(zoneId, !hasNoShuffle);
  const response = await playToZone(command, 'serviceplay', (parts) => {
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

export async function audioPlayUrl(command: string) {
  return playToZone(command, 'playurl', (parts) =>
    extractPayload(parts.slice(3)),
  );
}

export function audioDynamicCommand(command: string) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const cmd = (parts[2] ?? '').toLowerCase();
  const payload = parts.slice(3).join('/');
  zoneManager.handleCommand(zoneId, cmd, payload);
  return buildEmptyResponse(command);
}

export async function audioCfgGetRoomFavs(command: string) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[3], 0);
  const start = parseNumberPart(parts[4], 0);
  const limit = parseNumberPart(parts[5], 50);
  const favorites = await favoritesManager.get(zoneId, start, limit);
  return buildResponse(command, 'getroomfavs', [favorites]);
}

export async function audioCfgRoomFavs(command: string) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[3], 0);
  const action = (parts[4] ?? '').toLowerCase();
  const rest = parts.slice(5);

  switch (action) {
    case 'add': {
      const title = decodeSegment(rest[0] ?? '');
      const source = decodeSegment(rest.slice(1).join('/'));
      await favoritesManager.add(zoneId, title, source);
      return buildResponse(command, 'roomfavs_add', { title, source });
    }
    case 'setid': {
      const oldId = parseNumberPart(rest[0], 0);
      const newId = parseNumberPart(rest[1], 0);
      await favoritesManager.setId(zoneId, oldId, newId);
      return buildResponse(command, 'roomfavs_set', 'ok');
    }
    case 'delete': {
      const id = parseNumberPart(rest[0], 0);
      await favoritesManager.remove(zoneId, id);
      return buildResponse(command, 'roomfavs_delete', { id });
    }
    case 'reorder': {
      const order =
        rest[0]?.split(',').map((value) => Number(value)).filter(Boolean) ?? [];
      await favoritesManager.reorder(zoneId, order);
      return buildResponse(command, 'roomfavs_reorder', order);
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

export async function audioFavoritePlay(command: string) {
  const parts = splitCommand(command);
  const zoneId = parseNumberPart(parts[1], 0);
  const favoriteId = parseNumberPart(parts[4], 0);
  const fadeOpts = fadeController.parseFadeOptions(command);
  await playFavorite(zoneId, favoriteId);
  if (fadeOpts.fade) {
    const duration = fadeOpts.fadeDurationMs ?? 120_000;
    void fadeController.fadeIn(zoneId, duration);
  }
  return buildResponse(command, 'favoriteplay', [{ zoneId, favoriteId }]);
}

export async function audioRoomFavPlus(command: string) {
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
    await playFavorite(zoneId, next.id);
    metadata.lastFavoriteId = next.id;
  }

  return buildEmptyResponse(command);
}

async function playFavorite(zoneId: number, favoriteId: number): Promise<void> {
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
