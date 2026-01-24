import type { LoxoneHttpConfig } from '@/config/loxone';
import type { NotifierPort } from '@/ports/NotifierPort';
import { LoxoneRouter } from '@/adapters/loxone/commands/router/loxoneRouter';
import { createSecureHandlers } from '@/adapters/loxone/commands/handlers/secureHandlers';
import { createPlaceholderHandler } from '@/adapters/loxone/commands/handlers/placeholderHandlers';
import { createConfigHandlers } from '@/adapters/loxone/commands/handlers/configHandlers';
import { createProviderHandlers } from '@/adapters/loxone/commands/handlers/providerHandlers';
import { createZoneHandlers } from '@/adapters/loxone/commands/handlers/zoneHandlers';
import { createGlobalSearchHandlers } from '@/adapters/loxone/commands/handlers/globalSearchHandlers';
import { createGroupHandlers } from '@/adapters/loxone/commands/handlers/groupHandlers';
import {
  audioGroupedAlert,
  audioCfgUploadAudiouploadAdd,
  audioPlayUploadedAlert,
} from '@/adapters/loxone/commands/handlers/alertHandlers';
import { createInputHandlers } from '@/adapters/loxone/commands/handlers/inputHandlers';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { FavoritesManager } from '@/application/zones/favorites/favoritesManager';
import type { GroupManager } from '@/application/groups/groupManager';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { LineInIngestRegistry } from '@/adapters/inputs/linein/lineInIngestRegistry';
import type { SendspinLineInService } from '@/adapters/inputs/linein/sendspinLineInService';
import type { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import type { LoxoneConfigService } from '@/adapters/loxone/services/loxoneConfigService';

export interface RouteDependencies {
  config: LoxoneHttpConfig;
  onRestart?: () => Promise<boolean>;
  notifier: NotifierPort;
  loxoneNotifier: LoxoneWsNotifier;
  configService: LoxoneConfigService;
  zoneManager: ZoneManagerFacade;
  configPort: ConfigPort;
  lineInRegistry: LineInIngestRegistry;
  sendspinLineInService: SendspinLineInService;
  spotifyInputService: SpotifyInputService;
  recentsManager: RecentsManager;
  favoritesManager: FavoritesManager;
  groupManager: GroupManager;
  contentManager: ContentManager;
}

/**
 * Registers every known Loxone command route with the shared router.
 */
export function registerRoutes(
  router: LoxoneRouter,
  dependencies: RouteDependencies,
): void {
  const secure = createSecureHandlers(dependencies.configPort);
  const placeholder = (name: string) => createPlaceholderHandler(name);
  const configHandlers = createConfigHandlers(dependencies.config, {
    onRestart: dependencies.onRestart,
    notifier: dependencies.notifier,
    configService: dependencies.configService,
    configPort: dependencies.configPort,
    contentManager: dependencies.contentManager,
    spotifyInputService: dependencies.spotifyInputService,
  });
  const providerHandlers = createProviderHandlers(dependencies.contentManager, dependencies.loxoneNotifier);
  const globalSearchHandlers = createGlobalSearchHandlers(dependencies.contentManager, dependencies.loxoneNotifier);
  const zoneHandlers = createZoneHandlers(
    dependencies.zoneManager,
    dependencies.recentsManager,
    dependencies.favoritesManager,
    dependencies.contentManager,
  );
  const groupHandlers = createGroupHandlers(
    dependencies.zoneManager,
    dependencies.groupManager,
    dependencies.configPort,
  );
  const inputHandlers = createInputHandlers(dependencies.zoneManager, dependencies.configPort, {
    registry: dependencies.lineInRegistry,
    sendspinLineIn: dependencies.sendspinLineInService,
    notifier: dependencies.loxoneNotifier,
  });

  router.registerPrefix('secure', 'secure/info/pairing', secure.infoPairing);
  router.registerPrefix('secure', 'secure/hello', secure.hello);
  router.registerPrefix('secure', 'secure/authenticate', secure.authenticate);
  router.registerPrefix('secure', 'secure/init', secure.init);

  router.registerPrefix('audio', 'audio/cfg/globalsearch/describe', globalSearchHandlers.audioCfgGlobalSearchDescribe);
  router.registerPrefix('audio', 'audio/cfg/globalsearch', globalSearchHandlers.audioCfgGlobalSearch);

  router.registerPrefix('audio', 'audio/cfg/getmediafolder', providerHandlers.audioCfgGetMediaFolder);
  router.registerPrefix('audio', 'audio/cfg/rescan', providerHandlers.audioCfgRescan);
  router.registerPrefix('audio', 'audio/cfg/scanstatus', providerHandlers.audioCfgScanStatus);
  router.registerPrefix('audio', 'audio/cfg/storage/add', providerHandlers.audioCfgStorageAdd);
  router.registerPrefix('audio', 'audio/cfg/storage/list', providerHandlers.audioCfgStorageList);
  router.registerPrefix('audio', 'audio/cfg/storage/del', providerHandlers.audioCfgStorageDel);
  router.registerPrefix('audio', 'audio/cfg/getavailableservices', providerHandlers.audioCfgGetAvailableServices);
  router.registerPrefix('audio', 'audio/cfg/getservices', providerHandlers.audioCfgGetServices);
  router.registerPrefix('audio', 'audio/cfg/radios/add', placeholder('radios/add'));
  router.registerPrefix('audio', 'audio/cfg/radios/delete', placeholder('radios/delete'));
  router.registerPrefix('audio', 'audio/cfg/getradios', providerHandlers.audioCfgGetRadios);
  router.registerPrefix('audio', 'audio/cfg/getinputs', inputHandlers.audioCfgGetInputs);
  router.registerRegex('audio', /^audio\/cfg\/input\/[^/]+\/rename\//, inputHandlers.audioCfgInputRename);
  router.registerRegex('audio', /^audio\/cfg\/input\/[^/]+\/type\//, inputHandlers.audioCfgInputType);
  router.registerPrefix('audio', 'audio/cfg/getservicefolder', providerHandlers.audioCfgGetServiceFolder);
  router.registerPrefix('audio', 'audio/cfg/getplaylists2', providerHandlers.audioCfgGetPlaylists);
  router.registerPrefix('audio', 'audio/cfg/isfollowed', providerHandlers.audioCfgIsFollowed);
  router.registerPrefix('audio', 'audio/cfg/follow', providerHandlers.audioCfgFollow);
  router.registerPrefix('audio', 'audio/cfg/unfollow', providerHandlers.audioCfgUnfollow);
  router.registerPrefix('audio', 'audio/cfg/diagnosis', configHandlers.diagnosis);

  router.registerPrefix('audio', 'audio/cfg/getroomfavs', zoneHandlers.audioCfgGetRoomFavs);
  router.registerPrefix('audio', 'audio/cfg/roomfavs/', zoneHandlers.audioCfgRoomFavs);

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

  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/status\/?$/, zoneHandlers.audioGetStatus);
  router.registerRegex(
    'audio',
    /^audio\/(?:cfg\/)?\d+\/getqueue(?:\/\d+\/\d+)?\/?$/,
    zoneHandlers.audioCfgGetQueue,
  );
  router.registerRegex(
    'audio',
    /^audio\/(?:cfg\/)?\d+\/recent(?:\/(?:\d+|clear))?\/?$/,
    zoneHandlers.audioRecent,
  );
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/serviceplay\/.+$/, zoneHandlers.audioServicePlay);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/playlist\/play\/.+$/, zoneHandlers.audioPlaylistPlay);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/library\/play\/.+$/, zoneHandlers.audioLibraryPlay);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/roomfav\/play\//, zoneHandlers.audioFavoritePlay);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/roomfav\/plus$/, zoneHandlers.audioRoomFavPlus);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/playurl\/.+$/, zoneHandlers.audioPlayUrl);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/linein(?:\/.*)?$/, inputHandlers.audioLineIn);

  router.registerRegex('audio', /^audio\/grouped\/(pause|play|resume|stop)\//, groupHandlers.audioGroupedPlayback);
  router.registerRegex('audio', /^audio\/grouped\/volume\//, groupHandlers.audioGroupedVolume);
  router.registerRegex('audio', /^audio\/grouped\/playuploadedfile\//, audioPlayUploadedAlert);
  router.registerRegex('audio', /^audio\/grouped\/(?!playuploadedfile)[^/]+\/.+$/, audioGroupedAlert);

  router.registerRegex('audio', /^audio\/\d+\/mastervolume\//, groupHandlers.audioMasterVolume);
  router.registerRegex('audio', /^audio\/cfg\/dgroup\/update\//, groupHandlers.audioCfgDynamicGroup);
  router.registerRegex('audio', /^audio\/cfg\/defaultvolume\//, configHandlers.setDefaultVolume);
  router.registerRegex('audio', /^audio\/cfg\/maxvolume\//, configHandlers.setMaxVolume);
  router.registerRegex('audio', /^audio\/cfg\/eventvolumes\//, configHandlers.setEventVolumes);

  router.registerRegex(
    'audio',
    /^audio\/(?:cfg\/)?\d+\/(on|off|play|pause|resume|position|volume|queueplus|queueminus|repeat|shuffle(?:\/(?:enable|disable|on|off|1|0))?)(?:\/[+-]?\d+)?\/?$/,
    zoneHandlers.audioDynamicCommand,
  );
}
