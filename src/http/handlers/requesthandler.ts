import { handleSecureHello, handleSecureAuthenticate, handleSecureInit, handleSecureInfoPairing } from './secureCommands';
import {
  audioCfgReady,
  audioCfgGetConfig,
  audioCfgGetKey,
  audioCfgGetKeyFull,
  audioCfgIdentify,
  audioCfgMiniserverTime,
  audioCfgSetConfig,
  audioCfgSetConfigTimestamp,
  audioCfgSetVolumes,
  audioCfgSetPlayerOpts,
  audioCfgSetPlayerName,
  audioCfgSetDefaultVolume,
  audioCfgSetMaxVolume,
  audioCfgSetEventVolumes,
} from './configCommands';
import {
  audioCfgGetAvailableServices,
  audioCfgGetMediaFolder,
  audioCfgGetPlaylists,
  audioCfgGetRadios,
  audioCfgGetServiceFolder,
  audioCfgGlobalSearchDescribe,
  audioCfgScanStatus,
  audioCfgGlobalSearch
} from './providerCommands';
import {
  audioCfgGetQueue,
  audioCfgGetRoomFavs,
  audioCfgGetSyncedPlayers,
  audioDynamicCommand,
  audioGetStatus,
  audioLibraryPlay,
  audioPlaylistPlay,
  audioServicePlay,
  audioFavoritePlay,
  audioPlayUrl,
  audioRecent,
} from './zoneCommands';
import { CommandResult, emptyCommand, response } from './commandTypes';
import logger from '../../utils/troxorlogger';
import { summariseLoxoneCommand } from '../utils/requestSummary';
import { handleGroupedAlert } from './alertCommands';

/**
 * Central dispatcher translating Loxone HTTP command URLs into backend handler invocations.
 */

/**
 * Canonical Loxone command identifiers handled by this module.
 */
export const COMMANDS = {
  SECURE_INFO_PAIRING: 'secure/info/pairing',
  SECURE_HELLO: 'secure/hello',
  SECURE_AUTHENTICATE: 'secure/authenticate',
  SECURE_INIT: 'secure/init',
  MINISERVER_TIME: 'audio/cfg/miniservertime',
  AUDIO_CFG_IDENTIFY: 'audio/cfg/identify',
  AUDIO_CFG_READY: 'audio/cfg/ready',
  AUDIO_CFG_GET_CONFIG: 'audio/cfg/getconfig',
  AUDIO_CFG_SET_CONFIG: 'audio/cfg/setconfig',
  AUDIO_CFG_SET_CONFIG_TIMESTAMP: 'audio/cfg/setconfigtimestamp',
  AUDIO_CFG_SET_VOLUMES: 'audio/cfg/volumes',
  AUDIO_CFG_SET_PLAYER_OPTS: 'audio/cfg/playeropts',
  AUDIO_CFG_SET_PLAYER_NAME: 'audio/cfg/playername',
  AUDIO_CFG_GET_KEY: 'audio/cfg/getkey',
  AUDIO_CFG_GET_KEY_FULL: 'audio/cfg/getkey/full',
  AUDIO_CFG_GET_MEDIA_FOLDER: 'audio/cfg/getmediafolder',
  AUDIO_CFG_GET_AVAILABLE_SERVICES: 'audio/cfg/getavailableservices',
  AUDIO_CFG_GET_PLAYLISTS: 'audio/cfg/getplaylists2/lms',
  AUDIO_CFG_GET_RADIOS: 'audio/cfg/getradios',
  AUDIO_CFG_GET_SERVICE_FOLDER: 'audio/cfg/getservicefolder',
  AUDIO_CFG_GET_ROOM_FAVS: 'audio/cfg/getroomfavs',
  AUDIO_CFG_GET_SYNCED_PLAYERS: 'audio/cfg/getsyncedplayers',
  AUDIO_CFG_GLOBAL_SEARCH: 'audio/cfg/globalsearch',
  AUDIO_CFG_GLOBAL_SEARCH_DESCRIBE: 'audio/cfg/globalsearch/describe',
  AUDIO_CFG_GET_SCAN_STATUS: 'audio/cfg/scanstatus',
  AUDIO_CFG_GET_QUEUE: 'audio/\\d+/getqueue',
  AUDIO_CFG_DEFAULT_VOLUME: 'audio/cfg/defaultvolume',
  AUDIO_CFG_MAX_VOLUME: 'audio/cfg/maxvolume',
  AUDIO_CFG_EVENT_VOLUMES: 'audio/cfg/eventvolumes',
  AUDIO_PLAYER_STATUS: 'audio/\\d+/status',
  AUDIO_GROUP: 'audio/cfg/dgroup',
  AUDIO_SERVICE_PLAY: 'audio/\\d+/serviceplay',
  AUDIO_PLAYLIST_PLAY: 'audio/\\d+/playlist/play',
  AUDIO_LIBRARY_PLAY: 'audio/\\d+/library/play',
  AUDIO_RECENT: 'audio/\\d+/recent',
  AUDIO_COMMANDS_PATTERN: 'audio/\\d+/(on|off|play|resume|pause|queueminus|queue|queueplus|volume|repeat|shuffle|position|test)',
};

/**
 * Handler contract returning a command result (or undefined to fall back).
 */
type HandlerFn = (url: string) => CommandResult | Promise<CommandResult> | undefined;

interface Route {
  test: (url: string) => boolean;
  handler: HandlerFn;
}

const routesBySegment = new Map<string, Route[]>();
const allRoutes: Route[] = [];

function registerRoute(segment: string, route: Route) {
  const bucket = routesBySegment.get(segment);
  if (bucket) {
    bucket.push(route);
  } else {
    routesBySegment.set(segment, [route]);
  }
  allRoutes.push(route);
}

/**
 * Route helper matching URLs by fixed prefix.
 */
function prefixRoute(segment: string, prefix: string, handler: HandlerFn): void {
  registerRoute(segment, {
    test: (url: string) => url.startsWith(prefix),
    handler,
  });
}

/**
 * Route helper matching URLs via regular expressions.
 */
function regexRoute(segment: string, pattern: RegExp, handler: HandlerFn): void {
  registerRoute(segment, {
    test: (url: string) => pattern.test(url),
    handler,
  });
}

const AUDIO_PLAYER_STATUS_RE = /(?:^|\/)audio\/\d+\/status(?:\/|$)/;
const AUDIO_QUEUE_RE = /^audio\/\d+\/getqueue(?:\/\d+\/\d+)?$/;
const AUDIO_SERVICE_PLAY_RE = /^audio\/\d+\/serviceplay\//;
const AUDIO_PLAYLIST_PLAY_RE = /^audio\/\d+\/playlist\/play\//;
const AUDIO_LIBRARY_PLAY_RE = /^audio\/\d+\/library\/play\//;
const AUDIO_RECENT_RE = /^audio\/\d+\/recent(?:\/(?:\d+|clear))?$/;
const AUDIO_PLAY_URL_RE = /^audio\/\d+\/playurl\//;
const AUDIO_COMMANDS_RE = /(?:^|\/)audio\/\d+\/(on|off|play|resume|pause|queueminus|queue|queueplus|volume|repeat|shuffle|position|test)(?:\/|$)/;
const AUDIO_LIBRARY_ALIAS_RE = /^audio\/\d+\/(?:albums|artists|tracks):/;
const AUDIO_ROOM_FAV_PLAY_RE = /^audio\/\d+\/roomfav\/play\/\d+\/[^/]+(?:\/(?:no)?shuffle)?(?:\?.*)?$/;
const AUDIO_GROUPED_ALERT_RE = /^audio\/grouped\/[^/]+\/.+$/;
const AUDIO_CFG_DEFAULT_VOLUME_RE = /^audio\/cfg\/defaultvolume\/\d+\/[^/]+$/;
const AUDIO_CFG_MAX_VOLUME_RE = /^audio\/cfg\/maxvolume\/\d+\/[^/]+$/;
const AUDIO_CFG_EVENT_VOLUMES_RE = /^audio\/cfg\/eventvolumes\//;

/**
 * Ordered route table powering the incremental match within {@link handleLoxoneCommand}.
 */
prefixRoute('secure', COMMANDS.SECURE_INFO_PAIRING, handleSecureInfoPairing);
prefixRoute('secure', COMMANDS.SECURE_HELLO, handleSecureHello);
prefixRoute('secure', COMMANDS.SECURE_AUTHENTICATE, handleSecureAuthenticate);
prefixRoute('secure', COMMANDS.SECURE_INIT, handleSecureInit);

prefixRoute('audio', COMMANDS.MINISERVER_TIME, audioCfgMiniserverTime);
prefixRoute('audio', COMMANDS.AUDIO_CFG_GET_CONFIG, audioCfgGetConfig);
prefixRoute('audio', COMMANDS.AUDIO_CFG_READY, audioCfgReady);
prefixRoute('audio', COMMANDS.AUDIO_CFG_GET_KEY_FULL, audioCfgGetKeyFull);
prefixRoute('audio', COMMANDS.AUDIO_CFG_GET_KEY, audioCfgGetKey);
prefixRoute('audio', COMMANDS.AUDIO_CFG_SET_CONFIG_TIMESTAMP, audioCfgSetConfigTimestamp);
prefixRoute('audio', COMMANDS.AUDIO_CFG_SET_CONFIG, audioCfgSetConfig);
prefixRoute('audio', COMMANDS.AUDIO_CFG_SET_VOLUMES, audioCfgSetVolumes);
prefixRoute('audio', COMMANDS.AUDIO_CFG_SET_PLAYER_OPTS, audioCfgSetPlayerOpts);
prefixRoute('audio', COMMANDS.AUDIO_CFG_SET_PLAYER_NAME, audioCfgSetPlayerName);
prefixRoute('audio', COMMANDS.AUDIO_CFG_GET_MEDIA_FOLDER, audioCfgGetMediaFolder);
prefixRoute('audio', COMMANDS.AUDIO_CFG_GET_AVAILABLE_SERVICES, audioCfgGetAvailableServices);
prefixRoute('audio', COMMANDS.AUDIO_CFG_GET_ROOM_FAVS, audioCfgGetRoomFavs);
prefixRoute('audio', COMMANDS.AUDIO_CFG_GET_SYNCED_PLAYERS, audioCfgGetSyncedPlayers);
prefixRoute('audio', COMMANDS.AUDIO_CFG_GET_SCAN_STATUS, audioCfgScanStatus);
prefixRoute('audio', COMMANDS.AUDIO_CFG_GET_RADIOS, audioCfgGetRadios);
prefixRoute('audio', COMMANDS.AUDIO_CFG_GET_SERVICE_FOLDER, audioCfgGetServiceFolder);
prefixRoute('audio', COMMANDS.AUDIO_CFG_GET_PLAYLISTS, audioCfgGetPlaylists);
prefixRoute('audio', COMMANDS.AUDIO_CFG_GLOBAL_SEARCH_DESCRIBE, audioCfgGlobalSearchDescribe);
prefixRoute('audio', COMMANDS.AUDIO_CFG_GLOBAL_SEARCH, audioCfgGlobalSearch);
prefixRoute('audio', COMMANDS.AUDIO_CFG_IDENTIFY, audioCfgIdentify);

regexRoute('audio', AUDIO_PLAYER_STATUS_RE, audioGetStatus);
regexRoute('audio', AUDIO_QUEUE_RE, audioCfgGetQueue);
regexRoute('audio', AUDIO_RECENT_RE, audioRecent);
regexRoute('audio', AUDIO_SERVICE_PLAY_RE, audioServicePlay);
regexRoute('audio', AUDIO_PLAYLIST_PLAY_RE, audioPlaylistPlay);
regexRoute('audio', AUDIO_LIBRARY_PLAY_RE, audioLibraryPlay);
regexRoute('audio', AUDIO_ROOM_FAV_PLAY_RE, audioFavoritePlay);
regexRoute('audio', AUDIO_PLAY_URL_RE, audioPlayUrl);
regexRoute('audio', AUDIO_LIBRARY_ALIAS_RE, handleLibraryAlias);
regexRoute('audio', AUDIO_GROUPED_ALERT_RE, handleGroupedAlert);
regexRoute('audio', AUDIO_CFG_DEFAULT_VOLUME_RE, audioCfgSetDefaultVolume);
regexRoute('audio', AUDIO_CFG_MAX_VOLUME_RE, audioCfgSetMaxVolume);
regexRoute('audio', AUDIO_CFG_EVENT_VOLUMES_RE, audioCfgSetEventVolumes);
regexRoute('audio', AUDIO_COMMANDS_RE, audioDynamicCommand);

/**
 * Dispatch an incoming Loxone command URL to the matching handler.
 */
export const handleLoxoneCommand = async (trimmedUrl: string): Promise<string> => {
  if (!trimmedUrl) {
    return serializeResult(unknownCommand(''));
  }

  const normalizedUrl = trimmedUrl.trim();
  if (!normalizedUrl) {
    return serializeResult(unknownCommand(''));
  }

  const firstSlashIndex = normalizedUrl.indexOf('/');
  const segment = firstSlashIndex === -1 ? normalizedUrl : normalizedUrl.slice(0, firstSlashIndex);
  const bucket = routesBySegment.get(segment);

  if (bucket) {
    const matched = await dispatchThroughRoutes(bucket, normalizedUrl);
    if (matched) {
      return serializeResult(matched);
    }
    return serializeResult(unknownCommand(normalizedUrl));
  }

  const fallback = await dispatchThroughRoutes(allRoutes, normalizedUrl);
  return fallback ? serializeResult(fallback) : serializeResult(unknownCommand(normalizedUrl));
};

async function dispatchThroughRoutes(routes: Route[] | undefined, url: string): Promise<CommandResult | undefined> {
  if (!routes) return undefined;
  for (const route of routes) {
    if (!route.test(url)) continue;
    const result = await route.handler(url);
    if (result !== undefined) {
      return result;
    }
  }
  return undefined;
}

/**
 * Rewrites friendly library alias URLs into the canonical library play command.
 */
async function handleLibraryAlias(url: string): Promise<CommandResult> {
  const segments = url.split('/');
  const zoneId = segments[1];
  const alias = segments.slice(2).join('/');
  const synthetic = `audio/${zoneId}/library/play/${alias}`;
  logger.debug(`[RequestHandler] Translating library alias ${url} -> ${synthetic}`);
  const result = await audioLibraryPlay(synthetic);
  return { ...result, command: url };
}

/**
 * Fallback handler used when no route matches the requested URL.
 */
export function unknownCommand(url: string): CommandResult {
  logger.info(`[RequestHandler] Loxone Request not processed: ${summariseLoxoneCommand(url)}`);
  return emptyCommand(url, []);
}

/**
 * Serializes a command response to the wire format expected by Loxone.
 */
function serializeResult(result: CommandResult): string {
  if (result.raw) {
    return typeof result.payload === 'string' ? result.payload : JSON.stringify(result.payload);
  }

  return JSON.stringify(
    {
      [`${result.name}_result`]: result.payload,
      command: result.command,
    },
    null,
    2,
  );
}
