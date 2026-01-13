import type { LoxoneHttpConfig } from '@/config/loxone';
import { LoxoneRouter } from '@/modules/loxone/commands/router/loxoneRouter';
import { createSecureHandlers } from '@/modules/loxone/commands/handlers/secureHandlers';
import { createPlaceholderHandler } from '@/modules/loxone/commands/handlers/placeholderHandlers';
import { createConfigHandlers } from '@/modules/loxone/commands/handlers/configHandlers';
import {
  audioCfgFollow,
  audioCfgGetAvailableServices,
  audioCfgGetMediaFolder,
  audioCfgGetPlaylists,
  audioCfgGetRadios,
  audioCfgGetServiceFolder,
  audioCfgGetServices,
  audioCfgIsFollowed,
  audioCfgRescan,
  audioCfgScanStatus,
  audioCfgStorageAdd,
  audioCfgStorageDel,
  audioCfgStorageList,
  audioCfgUnfollow,
} from '@/modules/loxone/commands/handlers/providerHandlers';
import {
  audioCfgGetQueue,
  audioCfgGetRoomFavs,
  audioCfgRoomFavs,
  audioDynamicCommand,
  audioFavoritePlay,
  audioGetStatus,
  audioLibraryPlay,
  audioPlayUrl,
  audioPlaylistPlay,
  audioRecent,
  audioRoomFavPlus,
  audioServicePlay,
} from '@/modules/loxone/commands/handlers/zoneHandlers';
import {
  audioCfgGlobalSearch,
  audioCfgGlobalSearchDescribe,
} from '@/modules/loxone/commands/handlers/globalSearchHandlers';
import {
  audioCfgDynamicGroup,
  audioGroupedPlayback,
  audioGroupedVolume,
  audioMasterVolume,
} from '@/modules/loxone/commands/handlers/groupHandlers';
import {
  audioGroupedAlert,
  audioCfgUploadAudiouploadAdd,
  audioPlayUploadedAlert,
} from '@/modules/loxone/commands/handlers/alertHandlers';
import {
  audioCfgGetInputs,
  audioCfgInputRename,
  audioCfgInputType,
  audioLineIn,
} from '@/modules/loxone/commands/handlers/inputHandlers';

export interface RouteDependencies {
  config: LoxoneHttpConfig;
  onRestart?: () => Promise<boolean>;
}

/**
 * Registers every known Loxone command route with the shared router.
 */
export function registerRoutes(
  router: LoxoneRouter,
  dependencies: RouteDependencies,
): void {
  const secure = createSecureHandlers(dependencies.config);
  const placeholder = (name: string) => createPlaceholderHandler(name);
  const configHandlers = createConfigHandlers(dependencies.config, {
    onRestart: dependencies.onRestart,
  });

  router.registerPrefix('secure', 'secure/info/pairing', secure.infoPairing);
  router.registerPrefix('secure', 'secure/hello', secure.hello);
  router.registerPrefix('secure', 'secure/authenticate', secure.authenticate);
  router.registerPrefix('secure', 'secure/init', secure.init);

  router.registerPrefix('audio', 'audio/cfg/globalsearch/describe', audioCfgGlobalSearchDescribe);
  router.registerPrefix('audio', 'audio/cfg/globalsearch', audioCfgGlobalSearch);

  router.registerPrefix('audio', 'audio/cfg/getmediafolder', audioCfgGetMediaFolder);
  router.registerPrefix('audio', 'audio/cfg/rescan', audioCfgRescan);
  router.registerPrefix('audio', 'audio/cfg/scanstatus', audioCfgScanStatus);
  router.registerPrefix('audio', 'audio/cfg/storage/add', audioCfgStorageAdd);
  router.registerPrefix('audio', 'audio/cfg/storage/list', audioCfgStorageList);
  router.registerPrefix('audio', 'audio/cfg/storage/del', audioCfgStorageDel);
  router.registerPrefix('audio', 'audio/cfg/getavailableservices', audioCfgGetAvailableServices);
  router.registerPrefix('audio', 'audio/cfg/getservices', audioCfgGetServices);
  router.registerPrefix('audio', 'audio/cfg/radios/add', placeholder('radios/add'));
  router.registerPrefix('audio', 'audio/cfg/radios/delete', placeholder('radios/delete'));
  router.registerPrefix('audio', 'audio/cfg/getradios', audioCfgGetRadios);
  router.registerPrefix('audio', 'audio/cfg/getinputs', audioCfgGetInputs);
  router.registerRegex('audio', /^audio\/cfg\/input\/[^/]+\/rename\//, audioCfgInputRename);
  router.registerRegex('audio', /^audio\/cfg\/input\/[^/]+\/type\//, audioCfgInputType);
  router.registerPrefix('audio', 'audio/cfg/getservicefolder', audioCfgGetServiceFolder);
  router.registerPrefix('audio', 'audio/cfg/getplaylists2', audioCfgGetPlaylists);
  router.registerPrefix('audio', 'audio/cfg/isfollowed', audioCfgIsFollowed);
  router.registerPrefix('audio', 'audio/cfg/follow', audioCfgFollow);
  router.registerPrefix('audio', 'audio/cfg/unfollow', audioCfgUnfollow);
  router.registerPrefix('audio', 'audio/cfg/diagnosis', configHandlers.diagnosis);

  router.registerPrefix('audio', 'audio/cfg/getroomfavs', audioCfgGetRoomFavs);
  router.registerPrefix('audio', 'audio/cfg/roomfavs/', audioCfgRoomFavs);

  router.registerPrefix('audio', 'audio/cfg/miniservertime', configHandlers.miniserverTime);
  router.registerPrefix('audio', 'audio/cfg/getconfig', configHandlers.getConfig);
  router.registerPrefix('audio', 'audio/cfg/ready', configHandlers.ready);
  router.registerPrefix('audio', 'audio/cfg/getkey/full', configHandlers.getKeyFull);
  router.registerPrefix('audio', 'audio/cfg/getkey', configHandlers.getKey);
  router.registerPrefix('audio', 'audio/cfg/setconfigtimestamp', configHandlers.setConfigTimestamp);
  router.registerPrefix('audio', 'audio/cfg/setconfig', configHandlers.setConfig);
  router.registerPrefix('audio', 'audio/cfg/volumes', configHandlers.setVolumes);
  router.registerPrefix('audio', 'audio/cfg/playeropts', placeholder('playeropts'));
  router.registerPrefix('audio', 'audio/cfg/playername', configHandlers.playerName);
  router.registerPrefix('audio', 'audio/cfg/identify', configHandlers.identify);
  router.registerPrefix('audio', 'audio/cfg/geteq', configHandlers.getEq);
  router.registerPrefix('audio', 'audio/cfg/restart', configHandlers.restart);
  router.registerPrefix('audio', 'audio/cfg/speakertype', placeholder('speakertype'));
  router.registerPrefix('audio', 'audio/cfg/groupopts', placeholder('groupopts'));
  router.registerPrefix('audio', 'audio/cfg/presencemode', placeholder('presencemode'));
  router.registerPrefix('audio', 'audio/cfg/miniserverip', placeholder('miniserverip'));
  router.registerPrefix('audio', 'audio/cfg/miniserverversion', placeholder('miniserverversion'));
  router.registerPrefix('audio', 'audio/cfg/timezone', placeholder('timezone'));
  router.registerPrefix('audio', 'audio/cfg/servicecfg/getlink', configHandlers.serviceCfgGetLink);
  router.registerPrefix('audio', 'audio/cfg/servicecfg/delete', configHandlers.serviceCfgDelete);
  router.registerPrefix('audio', 'audio/cfg/upload/audioupload/add/', audioCfgUploadAudiouploadAdd);

  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/status\/?$/, audioGetStatus);
  router.registerRegex(
    'audio',
    /^audio\/(?:cfg\/)?\d+\/getqueue(?:\/\d+\/\d+)?\/?$/,
    audioCfgGetQueue,
  );
  router.registerRegex(
    'audio',
    /^audio\/(?:cfg\/)?\d+\/recent(?:\/(?:\d+|clear))?\/?$/,
    audioRecent,
  );
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/serviceplay\/.+$/, audioServicePlay);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/playlist\/play\/.+$/, audioPlaylistPlay);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/library\/play\/.+$/, audioLibraryPlay);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/roomfav\/play\//, audioFavoritePlay);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/roomfav\/plus$/, audioRoomFavPlus);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/playurl\/.+$/, audioPlayUrl);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/linein(?:\/.*)?$/, audioLineIn);

  router.registerRegex('audio', /^audio\/grouped\/(pause|play|resume|stop)\//, audioGroupedPlayback);
  router.registerRegex('audio', /^audio\/grouped\/volume\//, audioGroupedVolume);
  router.registerRegex('audio', /^audio\/grouped\/playuploadedfile\//, audioPlayUploadedAlert);
  router.registerRegex('audio', /^audio\/grouped\/(?!playuploadedfile)[^/]+\/.+$/, audioGroupedAlert);

  router.registerRegex('audio', /^audio\/\d+\/mastervolume\//, audioMasterVolume);
  router.registerRegex('audio', /^audio\/cfg\/dgroup\/update\//, audioCfgDynamicGroup);
  router.registerRegex('audio', /^audio\/cfg\/defaultvolume\//, configHandlers.setDefaultVolume);
  router.registerRegex('audio', /^audio\/cfg\/maxvolume\//, configHandlers.setMaxVolume);
  router.registerRegex('audio', /^audio\/cfg\/eventvolumes\//, configHandlers.setEventVolumes);

  router.registerRegex(
    'audio',
    /^audio\/(?:cfg\/)?\d+\/(on|off|play|pause|resume|position|volume|queueplus|queueminus|repeat|shuffle(?:\/(?:enable|disable|on|off|1|0))?)(?:\/[+-]?\d+)?\/?$/,
    audioDynamicCommand,
  );
}
