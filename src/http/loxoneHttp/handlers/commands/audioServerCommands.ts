import { CommandResult, response, emptyCommand } from '../requestHandler';
import { splitUrl, parseNumberPart, decodeSegment } from './utils/commandUtils';
import { zoneRuntime, zoneStateStore } from '@/runtime/zones';
import { favoritesManager } from '@/runtime/audioServer/favoritesManager';
import logger from '@/utils/troxorLogger';

/* -------------------------------------------------------------------------- */
/*  GET /audio/cfg/getroomfavs                                                */
/* -------------------------------------------------------------------------- */
export async function audioCfgGetRoomFavs(url: string): Promise<CommandResult> {
  const parts = splitUrl(url);
  const zoneId = parseNumberPart(parts[3], 0);
  const start = parseNumberPart(parts[4], 0);
  const limit = parseNumberPart(parts[5], 50);
  const favorites = await favoritesManager.get(zoneId, start, limit);
  return response(url, 'getroomfavs', [favorites]);
}

/* -------------------------------------------------------------------------- */
/*  /audio/cfg/roomfavs/... actions                                           */
/* -------------------------------------------------------------------------- */
export async function audioCfgRoomFavs(url: string): Promise<CommandResult> {
  const [, , , zoneStr, actionRaw, ...rest] = splitUrl(url);
  const zoneId = parseNumberPart(zoneStr, 0);
  const action = (actionRaw ?? '').toLowerCase();

  try {
    switch (action) {
      case 'add': {
        const title = decodeSegment(rest[0]);
        const encodedId = rest.slice(1).join('/');
        await favoritesManager.add(zoneId, decodeSegment(rest[0]), encodedId);
        return response(url, 'roomfavs_add', { encodedId, name: title });
      }
      case 'setid': {
        const oldId = parseNumberPart(rest[0], 0);
        const newId = parseNumberPart(rest[1], 0);
        await favoritesManager.setId(zoneId, oldId, newId);
        return response(url, 'roomfavs_set', 'ok');
      }
      case 'delete': {
        await favoritesManager.remove(zoneId, parseNumberPart(rest[0], 0));
        return response(url, 'roomfavs_delete', { delete_id: rest[0] });
      }
      case 'reorder': {
        const order = rest[0]?.split(',').map(Number).filter(Boolean) ?? [];
        await favoritesManager.reorder(zoneId, order);
        return response(url, 'roomfavs_reorder', order);
      }
      case 'copy': {
        const destinations = rest[0]?.split(',').map(Number).filter(Boolean) ?? [];
        await favoritesManager.copy(zoneId, destinations);
        return response(url, 'roomfavs_copy', 'ok');
      }
      default:
        logger.warn(`[ZoneCommands] Unknown roomfavs action: ${action}`);
        return response(url, 'roomfavs_error', {});
    }
  } catch (err) {
    logger.error(`[ZoneCommands] roomfavs error: ${String(err)}`);
    return response(url, 'roomfavs_error', {});
  }
}

/* -------------------------------------------------------------------------- */
/*  Play a specific favorite                                                  */
/* -------------------------------------------------------------------------- */
export async function audioFavoritePlay(url: string): Promise<CommandResult> {
  const parts = splitUrl(url);
  const zoneId = parseNumberPart(parts[1], 0);
  const favoriteId = parseNumberPart(parts[4], 0);
  const payload = `fav/${zoneId}/${parts.slice(4).join('/')}`;
  await zoneRuntime.sendZoneCommand(zoneId, 'contentplay', payload);
  return response(url, 'favoriteplay', [{ zoneId, favoriteId }]);
}

/* -------------------------------------------------------------------------- */
/*  /audio/<zone>/roomfav/plus                                                */
/* -------------------------------------------------------------------------- */
export async function audioRoomFavPlus(url: string): Promise<CommandResult> {
  try {
    const parts = splitUrl(url);
    const zoneId = parseNumberPart(parts[1], 0);
    const favs = await favoritesManager.get(zoneId);
    const items = favs.items ?? [];

    if (items.length === 0) {
      logger.warn(`[RoomFavPlus][Zone ${zoneId}] No favorites available`);
      return emptyCommand(url, []);
    }

    const zoneState = zoneStateStore.get(zoneId);
    const { audiopath = '', mode = 'stop', lastFavoriteId } = zoneState;

    if (mode === 'stop' || !audiopath) {
      const firstFav = items[0];
      if (firstFav) {
        const playUrl = `audio/${zoneId}/roomfav/play/${firstFav.id}/noshuffle`;
        await audioFavoritePlay(playUrl);
        zoneStateStore.patch(zoneId, { lastFavoriteId: firstFav.id });
      }
      return emptyCommand(url, []);
    }

    const currentIndex = typeof lastFavoriteId === 'number'
      ? items.findIndex((f: { id: number }) => f.id === lastFavoriteId)
      : items.findIndex((f: { audiopath: string }) => f.audiopath === audiopath);

    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % items.length : 0;
    const nextFav = items[nextIndex];
    if (nextFav) {
      const playUrl = `audio/${zoneId}/roomfav/play/${nextFav.id}/noshuffle`;
      await audioFavoritePlay(playUrl);
      zoneStateStore.patch(zoneId, { lastFavoriteId: nextFav.id });
    }

    return emptyCommand(url, []);
  } catch (err) {
    logger.error(`[RoomFavPlus] Failed: ${String(err)}`);
    return emptyCommand(url, []);
  }
}