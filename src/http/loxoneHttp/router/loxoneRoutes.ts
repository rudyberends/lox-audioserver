import { LoxoneRouter } from './loxoneRouter';
import {
  handleSecureHello,
  handleSecureAuthenticate,
  handleSecureInit,
  handleSecureInfoPairing,
} from '../handlers/commands/secureCommands';
import {
  audioCfgSpeakerType,
  audioCfgGroupOpts,
  audioCfgPresenceMode,
  audioCfgMiniServerIp,
  audioCfgMiniServerVersion,
  audioCfgTimeZone,
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
  audioCfgRestart,
} from '../handlers/commands/configCommands';

import {
  audioCfgGetAvailableServices,
  audioCfgGetServices,
  audioCfgGetMediaFolder,
  audioCfgGetPlaylists,
  audioCfgGetRadios,
  audioCfgGetServiceFolder,
  audioCfgScanStatus,
} from '../handlers/commands/providerCommands';

import { audioCfgGlobalSearch, audioCfgGlobalSearchDescribe } from '../handlers/commands/globalSearchCommands';
import { audioCfgGetRoomFavs, audioCfgRoomFavs, audioFavoritePlay, audioRoomFavPlus } from '../handlers/commands/audioServerCommands';

import {
  audioCfgGetQueue,
  audioCfgGetSyncedPlayers,
  audioDynamicCommand,
  audioGetStatus,
  audioLibraryPlay,
  audioPlaylistPlay,
  audioServicePlay,
  audioPlayUrl,
  audioRecent,
} from '../handlers/commands/zoneCommands';

import {
  audioCfgDynamicGroup,
  audioMasterVolume,
  audioGroupedVolume,
  audioGroupedPlayback,
} from '../handlers/commands/groupCommands';

import { audioCfgUploadAudioAdd } from '../handlers/commands/uploadCommands';
import { handleGroupedAlert, handlePlayUploadedFileAlert } from '../handlers/commands/alertCommands';

/**
 * Registers all known Loxone command routes with the given router.
 */
export function registerLoxoneRoutes(router: LoxoneRouter): void {
  // --- Secure routes
  router.registerPrefix('secure', 'secure/info/pairing', handleSecureInfoPairing);
  router.registerPrefix('secure', 'secure/hello', handleSecureHello);
  router.registerPrefix('secure', 'secure/authenticate', handleSecureAuthenticate);
  router.registerPrefix('secure', 'secure/init', handleSecureInit);
  router.registerPrefix('audio', 'audio/cfg/globalsearch/describe', audioCfgGlobalSearchDescribe);
  router.registerPrefix('audio', 'audio/cfg/globalsearch', audioCfgGlobalSearch);

  // --- Content routes
  router.registerPrefix('audio', 'audio/cfg/getmediafolder', audioCfgGetMediaFolder);
  router.registerPrefix('audio', 'audio/cfg/getroomfavs', audioCfgGetRoomFavs);
  router.registerPrefix('audio', 'audio/cfg/roomfavs/', audioCfgRoomFavs);
  router.registerPrefix('audio', 'audio/cfg/getradios', audioCfgGetRadios);
  router.registerPrefix('audio', 'audio/cfg/getservicefolder', audioCfgGetServiceFolder);
  router.registerPrefix('audio', 'audio/cfg/getplaylists2/lms', audioCfgGetPlaylists);

  // --- Config routes
  router.registerPrefix('audio', 'audio/cfg/miniservertime', audioCfgMiniserverTime);
  router.registerPrefix('audio', 'audio/cfg/getconfig', audioCfgGetConfig);
  router.registerPrefix('audio', 'audio/cfg/ready', audioCfgReady);
  router.registerPrefix('audio', 'audio/cfg/getkey/full', audioCfgGetKeyFull);
  router.registerPrefix('audio', 'audio/cfg/getkey', audioCfgGetKey);
  router.registerPrefix('audio', 'audio/cfg/setconfigtimestamp', audioCfgSetConfigTimestamp);
  router.registerPrefix('audio', 'audio/cfg/setconfig', audioCfgSetConfig);
  router.registerPrefix('audio', 'audio/cfg/volumes', audioCfgSetVolumes);
  router.registerPrefix('audio', 'audio/cfg/playeropts', audioCfgSetPlayerOpts);
  router.registerPrefix('audio', 'audio/cfg/playername', audioCfgSetPlayerName);
  router.registerPrefix('audio', 'audio/cfg/getavailableservices', audioCfgGetAvailableServices);
  router.registerPrefix('audio', 'audio/cfg/getservices', audioCfgGetServices);
  router.registerPrefix('audio', 'audio/cfg/getsyncedplayers', audioCfgGetSyncedPlayers);
  router.registerPrefix('audio', 'audio/cfg/scanstatus', audioCfgScanStatus);
  router.registerPrefix('audio', 'audio/cfg/identify', audioCfgIdentify);
  router.registerPrefix('audio', 'audio/cfg/restart', audioCfgRestart);
  router.registerPrefix('audio', 'audio/cfg/speakertype', audioCfgSpeakerType);
  router.registerPrefix('audio', 'audio/cfg/groupopts', audioCfgGroupOpts);
  router.registerPrefix('audio', 'audio/cfg/presencemode', audioCfgPresenceMode);
  router.registerPrefix('audio', 'audio/cfg/miniserverip', audioCfgMiniServerIp);
  router.registerPrefix('audio', 'audio/cfg/miniserverversion', audioCfgMiniServerVersion);
  router.registerPrefix('audio', 'audio/cfg/timezone', audioCfgTimeZone);

  // --- Upload routes
  router.registerPrefix('audio', 'audio/cfg/upload/audioupload/add/', audioCfgUploadAudioAdd);

  // --- Regex routes
  router.registerRegex('audio', /(?:^|\/)audio\/\d+\/status(?:\/|$)/, audioGetStatus);
  router.registerRegex('audio', /^audio\/\d+\/getqueue(?:\/\d+\/\d+)?$/, audioCfgGetQueue);
  router.registerRegex('audio', /^audio\/\d+\/recent(?:\/(?:\d+|clear))?$/, audioRecent);
  router.registerRegex('audio', /^audio\/\d+\/serviceplay\//, audioServicePlay);
  router.registerRegex('audio', /^audio\/\d+\/playlist\/play\//, audioPlaylistPlay);
  router.registerRegex('audio', /^audio\/\d+\/library\/play\//, audioLibraryPlay);
  router.registerRegex('audio', /^audio\/\d+\/roomfav\/play\//, audioFavoritePlay);
  router.registerRegex('audio', /^audio\/\d+\/roomfav\/plus$/, audioRoomFavPlus);
  router.registerRegex('audio', /^audio\/\d+\/playurl\//, audioPlayUrl);

  // --- Grouped actions
  router.registerRegex('audio', /^audio\/grouped\/(pause|play|resume|stop)\//, audioGroupedPlayback);
  router.registerRegex('audio', /^audio\/grouped\/volume\//, audioGroupedVolume);
  router.registerRegex('audio', /^audio\/grouped\/playuploadedfile\//, handlePlayUploadedFileAlert);
  router.registerRegex('audio', /^audio\/grouped\/(?!playuploadedfile)[^/]+\/.+$/, handleGroupedAlert);

  router.registerRegex('audio', /^audio\/\d+\/mastervolume\//, audioMasterVolume);
  router.registerRegex('audio', /^audio\/cfg\/dgroup\/update\//, audioCfgDynamicGroup);
  router.registerRegex('audio', /^audio\/cfg\/defaultvolume\//, audioCfgSetDefaultVolume);
  router.registerRegex('audio', /^audio\/cfg\/maxvolume\//, audioCfgSetMaxVolume);
  router.registerRegex('audio', /^audio\/cfg\/eventvolumes\//, audioCfgSetEventVolumes);
  // eslint-disable-next-line max-len
  router.registerRegex('audio', /audio\/\d+\/(on|off|play|pause|resume|position|volume|queueplus|queueminus|shuffle|repeat)(?:\/\d+)?/, audioDynamicCommand);
}