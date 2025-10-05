import { handleSecureHello, handleSecureAuthenticate, handleSecureInit, handleSecureInfoPairing } from './secureCommands';
import { audioCfgReady, audioCfgGetConfig, audioCfgGetKey } from './configCommands';
import {
  audioCfgGetMediaFolder,
  audioCfgGetPlaylists,
  audioCfgGetRadios,
  audioCfgGetServiceFolder,
  audioCfgScanStatus,
} from './providerCommands';
import {
  audioCfgGetQueue,
  audioCfgGetRoomFavs,
  audioCfgGetSyncedPlayers,
  audioGetStatus,
  audioLibraryPlay,
  audioPlaylistPlay,
  audioServicePlay,
} from './zoneCommands';
import logger from '../../utils/troxorlogger';

/**
 * Central dispatcher translating Loxone HTTP command URLs into backend handler invocations.
 */

/**
 * Produces a logging-safe summary of incoming URLs, trimming or redacting secrets.
 */
function summariseRequestUrl(url: string): string {
  const SECURE_INIT_PREFIX = 'secure/init/';
  if (url.startsWith(SECURE_INIT_PREFIX)) {
    const tokenLength = Math.max(0, url.length - SECURE_INIT_PREFIX.length);
    return `${SECURE_INIT_PREFIX}[token redacted, ${tokenLength} chars]`;
  }

  const SETCONFIG_PREFIX = 'audio/cfg/setconfig/';
  if (url.startsWith(SETCONFIG_PREFIX)) {
    const payloadLength = Math.max(0, url.length - SETCONFIG_PREFIX.length);
    return `${SETCONFIG_PREFIX}[payload trimmed, ${payloadLength} chars]`;
  }

  const SECURE_AUTH_PREFIX = 'secure/authenticate/';
  if (url.startsWith(SECURE_AUTH_PREFIX)) {
    const remainder = url.slice(SECURE_AUTH_PREFIX.length);
    const [identity = '', token = ''] = remainder.split('/', 2);
    return `${SECURE_AUTH_PREFIX}${identity}/[token redacted, ${token.length} chars]`;
  }

  const AUDIO_CFG_PREFIXES: Record<string, string> = {
    'audio/cfg/speakertype/': 'speakertype payload',
    'audio/cfg/volumes/': 'volume payload',
    'audio/cfg/playername/': 'player name payload',
    'audio/cfg/groupopts/': 'group options payload',
    'audio/cfg/playeropts/': 'player options payload',
  };

  for (const [prefix, label] of Object.entries(AUDIO_CFG_PREFIXES)) {
    if (url.startsWith(prefix)) {
      const payloadLength = Math.max(0, url.length - prefix.length);
      return `${prefix}[${label} trimmed, ${payloadLength} chars]`;
    }
  }

  const MAX_LENGTH = 320;
  if (url.length > MAX_LENGTH) {
    return `${url.slice(0, MAX_LENGTH)}… (truncated ${url.length - MAX_LENGTH} chars)`;
  }

  return url;
}
import { sendCommandToZone } from '../../backend/zone/zonemanager';

/**
 * Canonical Loxone command identifiers handled by this module.
 */
export const COMMANDS = {
  SECURE_INFO_PAIRING: 'secure/info/pairing',
  SECURE_HELLO: 'secure/hello',
  SECURE_AUTHENTICATE: 'secure/authenticate',
  SECURE_INIT: 'secure/init',
  MINISERVER_TIME: 'audio/cfg/miniservertime',
  AUDIO_CFG_READY: 'audio/cfg/ready',
  AUDIO_CFG_GET_CONFIG: 'audio/cfg/getconfig',
  AUDIO_CFG_SET_CONFIG: 'audio/cfg/setconfig',
  AUDIO_CFG_GET_KEY: 'audio/cfg/getkey',
  AUDIO_CFG_GET_MEDIA_FOLDER: 'audio/cfg/getmediafolder',
  AUDIO_CFG_GET_PLAYLISTS: 'audio/cfg/getplaylists2/lms',
  AUDIO_CFG_GET_RADIOS: 'audio/cfg/getradios',
  AUDIO_CFG_GET_SERVICE_FOLDER: 'audio/cfg/getservicefolder',
  AUDIO_CFG_GET_ROOM_FAVS: 'audio/cfg/getroomfavs',
  AUDIO_CFG_GET_SYNCED_PLAYERS: 'audio/cfg/getsyncedplayers',
  AUDIO_CFG_GET_SCAN_STATUS: 'audio/cfg/scanstatus',
  AUDIO_CFG_GET_QUEUE: 'audio/\\d+/getqueue',
  AUDIO_PLAYER_STATUS: 'audio/\\d+/status',
  AUDIO_GROUP: 'audio/cfg/dgroup',
  AUDIO_SERVICE_PLAY: 'audio/\\d+/serviceplay',
  AUDIO_PLAYLIST_PLAY: 'audio/\\d+/playlist/play',
  AUDIO_LIBRARY_PLAY: 'audio/\\d+/library/play',
  AUDIO_COMMANDS_PATTERN: 'audio/\\d+/(on|off|play|resume|pause|queueminus|queue|queueplus|volume|repeat|shuffle|test)',
};

export interface CommandResult {
  command: string;
  name: string;
  payload: unknown;
  raw?: boolean;
}

/**
 * Handler contract returning a command result (or undefined to fall back).
 */
type HandlerFn = (url: string) => CommandResult | Promise<CommandResult> | undefined;

interface Route {
  test: (url: string) => boolean;
  handler: HandlerFn;
}

/**
 * Route helper matching URLs by fixed prefix.
 */
const prefixRoute = (prefix: string, handler: HandlerFn): Route => ({
  test: (url: string) => url.startsWith(prefix),
  handler,
});

/**
 * Route helper matching URLs via regular expressions.
 */
const regexRoute = (pattern: RegExp, handler: HandlerFn): Route => ({
  test: (url: string) => pattern.test(url),
  handler,
});

const AUDIO_PLAYER_STATUS_RE = /(?:^|\/)audio\/\d+\/status(?:\/|$)/;
const AUDIO_QUEUE_RE = /^audio\/\d+\/getqueue(?:\/\d+\/\d+)?$/;
const AUDIO_SERVICE_PLAY_RE = /^audio\/\d+\/serviceplay\//;
const AUDIO_PLAYLIST_PLAY_RE = /^audio\/\d+\/playlist\/play\//;
const AUDIO_LIBRARY_PLAY_RE = /^audio\/\d+\/library\/play\//;
const AUDIO_COMMANDS_RE = /(?:^|\/)audio\/\d+\/(on|off|play|resume|pause|queueminus|queue|queueplus|volume|repeat|shuffle|test)(?:\/|$)/;
const AUDIO_LIBRARY_ALIAS_RE = /^audio\/\d+\/(?:albums|artists|tracks):/;

/**
 * Ordered route table powering the incremental match within {@link handleLoxoneCommand}.
 */
const routes: Route[] = [
  prefixRoute(COMMANDS.SECURE_INFO_PAIRING, handleSecureInfoPairing),
  prefixRoute(COMMANDS.SECURE_HELLO, handleSecureHello),
  prefixRoute(COMMANDS.SECURE_AUTHENTICATE, handleSecureAuthenticate),
  prefixRoute(COMMANDS.SECURE_INIT, handleSecureInit),
  prefixRoute(COMMANDS.AUDIO_CFG_GET_CONFIG, audioCfgGetConfig),
  prefixRoute(COMMANDS.AUDIO_CFG_READY, audioCfgReady),
  prefixRoute(COMMANDS.AUDIO_CFG_GET_KEY, audioCfgGetKey),
  prefixRoute(COMMANDS.AUDIO_CFG_GET_MEDIA_FOLDER, audioCfgGetMediaFolder),
  prefixRoute(COMMANDS.AUDIO_CFG_GET_ROOM_FAVS, audioCfgGetRoomFavs),
  prefixRoute(COMMANDS.AUDIO_CFG_GET_SYNCED_PLAYERS, audioCfgGetSyncedPlayers),
  prefixRoute(COMMANDS.AUDIO_CFG_GET_SCAN_STATUS, audioCfgScanStatus),
  prefixRoute(COMMANDS.AUDIO_CFG_GET_RADIOS, audioCfgGetRadios),
  prefixRoute(COMMANDS.AUDIO_CFG_GET_SERVICE_FOLDER, audioCfgGetServiceFolder),
  prefixRoute(COMMANDS.AUDIO_CFG_GET_PLAYLISTS, audioCfgGetPlaylists),
  regexRoute(AUDIO_PLAYER_STATUS_RE, audioGetStatus),
  regexRoute(AUDIO_QUEUE_RE, audioCfgGetQueue),
  regexRoute(AUDIO_SERVICE_PLAY_RE, audioServicePlay),
  regexRoute(AUDIO_PLAYLIST_PLAY_RE, audioPlaylistPlay),
  regexRoute(AUDIO_LIBRARY_PLAY_RE, audioLibraryPlay),
  regexRoute(AUDIO_LIBRARY_ALIAS_RE, handleLibraryAlias),
  regexRoute(AUDIO_COMMANDS_RE, handleDynamicAudioCommand),
];

/**
 * Dispatch an incoming Loxone command URL to the matching handler.
 */
export const handleLoxoneCommand = async (trimmedUrl: string): Promise<string> => {
  if (!trimmedUrl) {
    return serializeResult(unknownCommand(''));
  }

  for (const route of routes) {
    if (route.test(trimmedUrl)) {
      const result = await route.handler(trimmedUrl);
      return result !== undefined ? serializeResult(result as CommandResult) : serializeResult(unknownCommand(trimmedUrl));
    }
  }

  return serializeResult(unknownCommand(trimmedUrl));
};

/**
 * Handle the legacy dynamic audio command set (play, pause, volume, etc.).
 */
function handleDynamicAudioCommand(url: string): CommandResult {
  const parts = url.split('/');
  const playerID = Number(parts[1]);
  const command = parts[2];
  const extraSegments = parts.slice(3);
  const param: string | string[] | undefined = extraSegments.length > 1 ? extraSegments : extraSegments[0];

  sendCommandToZone(playerID, command, param);
  return emptyCommand(url, []);
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
  logger.info(`[RequestHandler] Loxone Request not processed: ${summariseRequestUrl(url)}`);
  return emptyCommand(url, []);
}

/**
 * Produce a response payload with an empty result structure for the given command URL.
 */
export function emptyCommand(url: string, rsp: unknown): CommandResult {
  const parts = url.split('/');
  for (let i = parts.length; i--;) {
    if (/^[a-z]/.test(parts[i])) {
      return response(url, parts[i], rsp);
    }
  }
  return response(url, 'response', rsp);
}

/**
 * Build the standard Loxone JSON response wrapper for a handler result.
 */
export function response(url: string, name: string, result: unknown): CommandResult {
  const sanitizedUrl = url.trim();
  const sanitizedName = name.trim();

  return {
    command: sanitizedUrl,
    name: sanitizedName,
    payload: result,
  };
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
