import { loadConfig } from '@/config';
import { loadEnvironment } from '@/config/environment';
import { createLogger, logManager } from '@/shared/logging/logger';
import { createContentManager } from '@/adapters/content/contentManager';
import { createContentAdapter } from '@/adapters/content/ContentAdapter';
import { toLoxoneAudiopath } from '@/domain/loxone/bridgeIdentity';
import { MediaServer } from '@/adapters/mediaserver/mediaServer';
import { SubsonicApi } from '@/adapters/subsonic/subsonicApi';
import { SsdpAdvertiser } from '@sonn-audio/node-upnp';
import { DlnaInputService } from '@/adapters/inputs/dlna/dlnaInputService';
import { CustomRadioStore } from '@/adapters/content/providers/customRadioStore';
import { SpotifyServiceManagerProvider } from '@/adapters/content/providers/spotifyServiceManager';
import { AppleMusicStreamService } from '@/adapters/content/providers/applemusic/appleMusicStreamService';
import { setAppleMusicDeveloperTokenSource } from '@/adapters/content/providers/applemusic/appleMusicAuth';
import { AppleMusicStreamResolver } from '@/adapters/content/providers/applemusic/appleMusicStreamResolver';
import { DeezerStreamService } from '@/adapters/content/providers/deezer/deezerStreamService';
import { DeezerStreamResolver } from '@/adapters/content/providers/deezer/deezerStreamResolver';
import { TidalStreamService } from '@/adapters/content/providers/tidal/tidalStreamService';
import { TidalStreamResolver } from '@/adapters/content/providers/tidal/tidalStreamResolver';
import { YtMusicStreamService } from '@/adapters/content/providers/ytmusic/ytmusicStreamService';
import { YtMusicStreamResolver } from '@/adapters/content/providers/ytmusic/ytmusicStreamResolver';
import { YoutubeStreamService } from '@/adapters/content/providers/youtube/youtubeStreamService';
import { YoutubeStreamResolver } from '@/adapters/content/providers/youtube/youtubeStreamResolver';
import { SoundCloudStreamService } from '@/adapters/content/providers/soundcloud/soundcloudStreamService';
import { SoundCloudStreamResolver } from '@/adapters/content/providers/soundcloud/soundcloudStreamResolver';
import { HttpService } from '@/adapters/http';
import { LoxoneHttpService } from '@/adapters/loxone/http';
import { LoxoneCommandProcessor } from '@/adapters/loxone/http/commandProcessor';
import { BrowserZoneRegistry } from '@/application/zones/browserZoneRegistry';
import { createInputsAdapter } from '@/adapters/inputs/InputsAdapter';
import { createOutputsAdapter } from '@/adapters/outputs/OutputsAdapter';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';
import { EngineAdapter } from '@/adapters/engine/EngineAdapter';
import { AudioStreamEngine } from '@/engine/audioStreamEngine';
import { createZoneManager, type ZoneManagerFacade } from '@/application/zones/createZoneManager';
import { resolveZoneOutputProtocol } from '@/application/zones/outputProtocol';
import type { AudioServerConfig } from '@/domain/config/types';
import { PlaybackService } from '@/application/playback/PlaybackService';
import { AirplayInputService } from '@/adapters/inputs/airplay/airplayInputService';
import { LineInMetadataService } from '@/adapters/inputs/linein/lineInMetadataService';
import { SendspinLineInService } from '@/adapters/inputs/linein/sendspinLineInService';
import { MusicAssistantStreamService } from '@/adapters/inputs/musicassistant/musicAssistantStreamService';
import { MusicAssistantInputService } from '@/adapters/inputs/musicassistant/musicAssistantInputService';
import { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import { SpotifyStreamProxyService } from '@/adapters/inputs/spotify/spotifyStreamProxyService';
import { LineInIngestRegistry } from '@/adapters/inputs/linein/lineInIngestRegistry';
import { LineInActivationRegistry } from '@/adapters/inputs/linein/lineInActivationRegistry';
import { SendspinHookRegistry } from '@/adapters/outputs/sendspin/sendspinHookRegistry';
import { SpotifyDeviceRegistry } from '@/adapters/outputs/spotify/deviceRegistry';
import { StreamEvents } from '@/adapters/http/streams/streamEvents';
import { SendspinClientConnector } from '@/adapters/outputs/sendspin/sendspinClientConnector';
import { SnapcastCore } from '@/adapters/outputs/snapcast/snapcastCore';
import { AudioManager } from '@/application/playback/audioManager';
import { ZoneAudioPreferences } from '@/application/playback/ZoneAudioPreferences';
import { SqueezeliteCore } from '@/adapters/outputs/squeezelite/squeezeliteCore';
import { LmsCliServer } from '@/adapters/outputs/squeezelite/lmsCliServer';
import { NetworkService } from '@/adapters/network';
import { MdnsService } from '@/adapters/discovery';
import { SonnCoreMdnsService } from '@/adapters/discovery/sonnCoreMdnsService';
import { SonnCorePeerRegistry } from '@/adapters/discovery/sonnCorePeerRegistry';
import { SnapcastMdnsService } from '@/adapters/outputs/snapcast/snapcastMdnsService';
import { SendspinServerAdvertiser } from '@/adapters/outputs/sendspin/sendspinServerAdvertiser';
import type { MdnsLifecycleService } from '@/adapters/discovery/mdnsLifecycle';
import { createAirplayGroupController } from '@/application/outputs/airplayGroupController';
import { createSnapcastGroupController } from '@/application/outputs/snapcastGroupController';
import { sonosGroupController } from '@/application/outputs/sonosGroupController';
import { sendspinGroupController } from '@/application/outputs/sendspinGroupController';
import { createSqueezeliteGroupController } from '@/application/outputs/squeezeliteGroupController';
import { createGroupManager } from '@/application/groups/groupManager';
import { createGroupTrackerPort } from '@/application/groups/groupTrackerPort';
import { createPlayerRegistryPort } from '@/application/playback/playerRegistryPort';
import { createFadeControllerPort } from '@/application/zones/fadeControllerPort';
import { createAlertsPort } from '@/application/alerts/alertsPort';
import { createAlertFilesPort } from '@/application/alerts/alertFilesPort';
import { createMixedGroupController } from '@/application/groups/mixedGroupController';
import { createFavoritesManager } from '@/application/zones/favorites/favoritesManager';
import { createRecentsManager } from '@/application/zones/recents/recentsManager';
import { createRuntimePorts, createZoneManagerProxy } from '@/runtime/ports';
import { alertsManager } from '@/application/alerts/alertsManager';
import { fadeController } from '@/application/zones/fadeController';
import { LoxoneNotifierAdapter } from '@/adapters/loxone/LoxoneNotifierAdapter';
import { ConnectionRegistry } from '@/adapters/loxone/ws/connectionRegistry';
import { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import { ServerHeartbeat } from '@/adapters/loxone/ws/serverHeartbeat';
import { LoxoneConfigService } from '@/adapters/loxone/services/loxoneConfigService';
import { stopWithTimeout } from '@/runtime/stopWithTimeout';

/**
 * Descriptor for services that need graceful shutdown coordination.
 */
type LifecycleService = {
  name: string;
  stop: () => Promise<void>;
};

export type Runtime = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

type OutputHandlers = ReturnType<ZoneManagerFacade['getOutputHandlers']>;

export function createRuntime(): Runtime {
  const connectionRegistry = new ConnectionRegistry();
  const groupTracker = createGroupTrackerPort();
  const playerRegistry = createPlayerRegistryPort();
  const fadeControllerPort = createFadeControllerPort();
  const alertsPort = createAlertsPort();
  const alertFilesPort = createAlertFilesPort();
  const loxoneNotifier = new LoxoneWsNotifier(connectionRegistry, groupTracker);
  const ports = createRuntimePorts({ notifier: new LoxoneNotifierAdapter(loxoneNotifier) });
  const configPort = ports.config;
  // Drive the per-session crossfade pipeline-shape from the system-wide
  // `audioserver.crossfadeSec` config: when crossfade is off (0 or empty) the
  // engine starts a single ffmpeg per file/URL zone instead of decoder+encoder.
  const audioStreamEngine = new AudioStreamEngine(
    () => (configPort.getSystemConfig()?.audioserver?.crossfadeSec ?? 0) > 0,
  );
  const customRadioStore = new CustomRadioStore();
  const spotifyManagerProvider = new SpotifyServiceManagerProvider(configPort);
  const spotifyDeviceRegistry = new SpotifyDeviceRegistry();
  let outputHandlers: OutputHandlers | null = null;
  const requireOutputHandlers = (): OutputHandlers => {
    if (!outputHandlers) {
      throw new Error('output handlers not configured');
    }
    return outputHandlers;
  };
  const outputHandlersProxy: OutputHandlers = {
    onQueueUpdate: (zoneId, items, currentIndex) => {
      requireOutputHandlers().onQueueUpdate(zoneId, items, currentIndex);
    },
    onOutputError: (zoneId, reason) => {
      requireOutputHandlers().onOutputError(zoneId, reason);
    },
    onOutputState: (zoneId, state) => {
      requireOutputHandlers().onOutputState(zoneId, state);
    },
  };
  const outputNotifier = {
    notifyOutputError: outputHandlersProxy.onOutputError,
    notifyOutputState: outputHandlersProxy.onOutputState,
  };
  // Source the Apple Music developer token live from config for the auth flow and API bearer.
  setAppleMusicDeveloperTokenSource(() => configPort.getConfig().content?.appleMusic?.developerToken);
  const appleMusicStreamService = new AppleMusicStreamService(outputHandlersProxy.onOutputError, configPort);
  const deezerStreamService = new DeezerStreamService(outputHandlersProxy.onOutputError, configPort);
  const tidalStreamService = new TidalStreamService(outputHandlersProxy.onOutputError, configPort);
  const ytmusicStreamService = new YtMusicStreamService(outputHandlersProxy.onOutputError, configPort);
  const youtubeStreamService = new YoutubeStreamService(outputHandlersProxy.onOutputError, configPort);
  const soundcloudStreamService = new SoundCloudStreamService(outputHandlersProxy.onOutputError, configPort);
  const appleMusicStreamResolver = new AppleMusicStreamResolver(appleMusicStreamService);
  const deezerStreamResolver = new DeezerStreamResolver(deezerStreamService);
  const tidalStreamResolver = new TidalStreamResolver(tidalStreamService);
  const ytmusicStreamResolver = new YtMusicStreamResolver(ytmusicStreamService);
  const youtubeStreamResolver = new YoutubeStreamResolver(youtubeStreamService);
  const soundcloudStreamResolver = new SoundCloudStreamResolver(soundcloudStreamService);
  const engine = new EngineAdapter(audioStreamEngine);
  const lineInRegistry = new LineInIngestRegistry();
  const mdnsService = new MdnsService();
  const sonnCorePeers = new SonnCorePeerRegistry(mdnsService);
  sonnCorePeers.start();
  const sendspinConnector = new SendspinClientConnector(mdnsService);
  let sendspinServerAdvertiser: SendspinServerAdvertiser | null = null;
  let sonnCoreMdnsService: SonnCoreMdnsService | null = null;
  let snapcastMdnsService: SnapcastMdnsService | null = null;
  let mediaServer: MediaServer | null = null;
  // Shared SSDP advertiser: one UDP socket on :1900 for the MediaServer plus every
  // per-zone DLNA MediaRenderer input. Devices register/deregister themselves.
  const ssdpAdvertiser = new SsdpAdvertiser({ serverHeader: 'Linux/5 UPnP/1.0 SonnAudio/1.0' });
  const dlnaHttpPort = loadEnvironment().httpPort;
  const dlnaInputService = new DlnaInputService(configPort, ssdpAdvertiser, dlnaHttpPort);
  const mdnsServices: MdnsLifecycleService[] = [];
  const streamEvents = new StreamEvents();
  const serverHeartbeat = new ServerHeartbeat(connectionRegistry);
  const sendspinHookRegistry = new SendspinHookRegistry();
  const sendspinLineInService = new SendspinLineInService(lineInRegistry, sendspinHookRegistry, configPort);
  const lineInActivation = new LineInActivationRegistry();
  const lineInMetadataService = new LineInMetadataService(lineInRegistry);
  const musicAssistantStreamService = new MusicAssistantStreamService(outputHandlersProxy, configPort);
  const musicAssistantInputService = new MusicAssistantInputService(musicAssistantStreamService);
  let airplayInputService: AirplayInputService | null = null;
  const stopAirplaySession = (zoneId: number, reason?: string) => {
    if (!airplayInputService) {
      throw new Error('airplay input service not initialized');
    }
    airplayInputService.stopActiveSession(zoneId, reason);
  };
  const spotifyStreamProxyService = new SpotifyStreamProxyService();
  const spotifyInputService = new SpotifyInputService(
    outputHandlersProxy.onOutputError,
    configPort,
    spotifyManagerProvider,
    spotifyDeviceRegistry,
    stopAirplaySession,
    playerRegistry,
    spotifyStreamProxyService,
  );
  airplayInputService = new AirplayInputService((zoneId, reason) => {
    spotifyInputService.stopActiveSession(zoneId, reason);
  }, playerRegistry);
  if (!airplayInputService) {
    throw new Error('airplay input service not initialized');
  }
  const inputsAdapter = createInputsAdapter({
    airplay: airplayInputService,
    spotify: spotifyInputService,
    musicAssistant: musicAssistantInputService,
    sendspinLineIn: sendspinLineInService,
    lineInActivation,
    dlna: dlnaInputService,
  });
  const zoneAudioPrefs = new ZoneAudioPreferences();
  const audioManager = new AudioManager(new PlaybackService(engine), outputNotifier, zoneAudioPrefs);
  const airplayGroupController = createAirplayGroupController(audioManager);
  const snapcastGroupController = createSnapcastGroupController(audioManager);
  const squeezeliteGroupController = createSqueezeliteGroupController();
  const snapcastCore = new SnapcastCore(audioManager);
  const squeezeliteCore = new SqueezeliteCore(configPort);
  const squeezeliteCli = new LmsCliServer(squeezeliteCore, configPort);
  const contentManager = createContentManager({
    notifier: ports.notifier,
    configPort,
    spotifyManagerProvider,
    customRadioStore,
  });
  const contentAdapter = createContentAdapter(contentManager, {
    appleMusic: appleMusicStreamResolver,
    deezer: deezerStreamResolver,
    tidal: tidalStreamResolver,
    ytmusic: ytmusicStreamResolver,
    youtube: youtubeStreamResolver,
    soundcloud: soundcloudStreamResolver,
  });
  const groupManager = createGroupManager({ notifier: ports.notifier, airplayGroup: airplayGroupController, configPort });
  const mixedGroupController = createMixedGroupController(configPort, audioManager);
  const favoritesManager = createFavoritesManager({ notifier: ports.notifier, contentPort: contentAdapter });
  const recentsManager = createRecentsManager({ notifier: ports.notifier, contentPort: contentAdapter });
  let zoneManagerRef: ZoneManagerFacade | null = null;
  const requireZoneManager = (): ZoneManagerFacade => {
    if (!zoneManagerRef) {
      throw new Error('zone manager not configured');
    }
    return zoneManagerRef;
  };
  const zoneManagerProxy = createZoneManagerProxy(requireZoneManager);
  const outputPorts: OutputPorts = {
    engine,
    audioManager: {
      getSession: (zoneId) => audioManager.getSession(zoneId),
      getOutputSettings: (zoneId) => audioManager.getOutputSettings(zoneId),
      startExternalPlayback: (zoneId, label, playbackSource, metadata, requiresPcm) =>
        audioManager.startExternalPlayback(zoneId, label, playbackSource, metadata, requiresPcm),
    },
    zoneAudioPrefs: {
      getEffectiveOutputSettings: (zoneId) => zoneAudioPrefs.getEffectiveOutputSettings(zoneId),
    },
    outputStreamEvents: streamEvents,
    airplayGroup: airplayGroupController,
    snapcastCore,
    snapcastGroup: snapcastGroupController,
    sonosGroup: sonosGroupController,
    sendspinGroup: sendspinGroupController,
    sendspinHooks: sendspinHookRegistry,
    sendspinConnector,
    squeezeliteGroup: squeezeliteGroupController,
    squeezeliteCore,
    zoneManager: zoneManagerProxy,
    groupManager,
    groupTracker,
    outputHandlers: outputHandlersProxy,
    config: configPort,
    spotifyManagerProvider,
    spotifyDeviceRegistry,
  };
  const outputsAdapter = createOutputsAdapter(outputPorts);
  const zoneManager = createZoneManager({
    notifier: ports.notifier,
    inputs: inputsAdapter,
    outputs: outputsAdapter,
    content: contentAdapter,
    config: configPort,
    recents: recentsManager,
    audioManager,
    zoneAudioPrefs,
    mixedGroup: mixedGroupController,
  });
  zoneManagerRef = zoneManager;
  loxoneNotifier.setZoneStateLookup((zoneId) => zoneManager.getState(zoneId));
  // Surface each zone's output protocol in audio_event so our player can hint
  // grouping compatibility (grouping requires matching protocols).
  loxoneNotifier.setOutputProtocolLookup((zoneId) =>
    resolveZoneOutputProtocol(zoneManager.getTechnicalSnapshot(zoneId)),
  );
  loxoneNotifier.setMixedGroupLookup(
    () => configPort.getConfig().groups?.mixedGroupEnabled === true,
  );
  // Loxone-boundary: translate the core's service-native audiopath back to the
  // `spotify@bridge-...` disguise so the native client's now-playing keeps its
  // service/account attribution (isSpotifyPlaying + serviceId regex). No-op on
  // non-bridge paths.
  loxoneNotifier.setAudiopathToLoxone((audiopath) =>
    toLoxoneAudiopath(audiopath, contentManager.getBridgeRegistry()),
  );
  // Let recents fall back to the live now-playing state for titles missing on
  // the queue item (e.g. radio/tunein station names).
  recentsManager.setZoneStateLookup((zoneId) => zoneManager.getState(zoneId));
  lineInMetadataService.initOnce({ zoneManager, configPort });
  snapcastCore.initOnce({ zoneManager });
  groupManager.initOnce({ zoneManager });
  mixedGroupController.initOnce({ zoneManager });
  favoritesManager.initOnce({ zoneManager });
  alertsManager.initOnce({ zoneManager, configPort });
  fadeController.initOnce({ zoneManager });
  sendspinGroupController.initOnce({ zoneManager });
  const loxoneConfigService = new LoxoneConfigService(
    zoneManager,
    configPort,
    contentManager,
    ports.notifier,
  );
  outputHandlers = zoneManager.getOutputHandlers();

  let httpService: HttpService | null = null;
  let networkService: NetworkService | null = null;
  let loxoneService: LoxoneHttpService | null = null;
  let browserZoneRegistry: BrowserZoneRegistry | null = null;
  let restartInFlight = false;

  async function handleReinitialize(): Promise<boolean> {
    const log = createLogger('Server');
    if (restartInFlight) {
      log.warn('restart already in progress; ignoring reinitialize request');
      return false;
    }
    restartInFlight = true;
    try {
      log.info('light reinitialize requested');
      const cfg = await configPort.load();
      await contentManager.reinitialize();
      await zoneManager.replaceAll(cfg.zones ?? [], cfg.inputs ?? null, cfg.groups ?? null);
      log.info('light reinitialize complete');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('light reinitialize failed', { message });
      return false;
    } finally {
      restartInFlight = false;
    }
  }

  async function handleSoftRestart(): Promise<boolean> {
    const log = createLogger('Server');
    if (restartInFlight) {
      log.warn('restart already in progress; ignoring duplicate request');
      return false;
    }
    restartInFlight = true;
    try {
      log.info('soft restart requested');
      await stopServices();
      await startServices();
      log.info('soft restart complete');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('soft restart failed', { message });
      return false;
    } finally {
      restartInFlight = false;
    }
  }

  async function startServices(): Promise<void> {
    const storedConfig = await configPort.load();
    const config = loadConfig(storedConfig.system?.audioserver?.macId);
    const logLevel = storedConfig.system?.logging?.consoleLevel ?? config.env.logLevel;
    logManager.configure({ level: logLevel });
    const log = createLogger('Server');

    // "uit is uit": in standalone mode the server exposes no Loxone protocol at
    // all — neither the dedicated Miniserver/native-app server (7091/7095 + UDP
    // discovery) nor the Loxone command dialect on the shared :7090 gateway.
    // Only the neutral surfaces run (DLNA MediaServer, Subsonic, admin API, the
    // /audio/events state mirror). The own player, still a Loxone client today,
    // is knowingly disabled here until it moves to a native API.
    // There is no deployment "mode": the server is just a server, and Loxone is a
    // connection. The stack runs iff Loxone is connected. Config migration seeds
    // `loxoneEnabled` from the old mode/paired, so existing installs are unchanged.
    // The stack can't reach `paired` on its own, so a new Loxone box goes: connect
    // (from the Players modal) → loxoneEnabled=true → soft restart → gate opens →
    // Miniserver pairs.
    const loxoneEnabled = storedConfig.system?.audioserver?.loxoneEnabled === true;

    log.info('bootstrapping audio server', {
      env: config.env.nodeEnv,
      loxoneEnabled,
    });

    await zoneManager.initialize();
    await contentManager.reinitialize();

    // Restore manual audio groups that were persisted before the last shutdown.
    const persistedGroups = storedConfig.groups?.audioGroups ?? [];
    for (const g of persistedGroups) {
      if (g.externalId && g.leader > 0 && g.members.length > 0) {
        groupManager.upsert({ leader: g.leader, members: g.members, externalId: g.externalId, backend: 'Unknown', source: 'manual' });
      }
    }
    if (persistedGroups.length) {
      log.info('restored persisted audio groups', { count: persistedGroups.length });
    }

    lineInMetadataService.start();
    sendspinLineInService.start();
    await squeezeliteCore.start();
    await squeezeliteCli.start();

    // The Loxone command engine + protocol servers are a runtime subsystem, not a
    // boot-time gate: connecting/disconnecting Loxone attaches/detaches them while
    // the rest of the server keeps running. Built lazily so a plain server never
    // constructs the engine. (Hoisted so onLoxoneToggle below can reference them.)
    function buildLoxoneProcessor(): LoxoneCommandProcessor {
      return new LoxoneCommandProcessor(config.loxone, {
        onRestart: handleSoftRestart,
        notifier: ports.notifier,
        loxoneNotifier,
        configService: loxoneConfigService,
        zoneManager,
        configPort,
        lineInRegistry,
        lineInActivation,
        sendspinLineInService,
        spotifyInputService,
        recentsManager,
        favoritesManager,
        groupManager,
        groupTracker,
        fadeController: fadeControllerPort,
        alerts: alertsPort,
        contentManager,
        sonnCorePeers,
      });
    }

    // Start the Loxone subsystem: attach the command engine to the shared :7090
    // gateway and start the dedicated 7091/7095 servers + UDP discovery. Idempotent.
    // persist=false at boot (the flag is already set); true for a runtime connect.
    async function enableLoxone(persist = true): Promise<void> {
      if (loxoneService) return;
      const processor = buildLoxoneProcessor();
      httpService?.setLoxoneProcessor(processor);
      const service = new LoxoneHttpService(config.loxone, {
        host: config.env.hostname,
        processor,
        connectionRegistry,
        serverHeartbeat,
        zoneManager,
        configPort,
      });
      loxoneService = service;
      try {
        await service.start();
      } catch (error) {
        // Roll back so a retry isn't blocked by a half-started subsystem (and the
        // gateway doesn't keep accepting Loxone commands nothing is serving).
        try {
          await service.stop();
        } catch {
          // Ignore: we're already unwinding a failed start.
        }
        loxoneService = null;
        httpService?.setLoxoneProcessor(null);
        throw error;
      }
      if (persist) {
        await configPort.updateConfig((cfg) => {
          cfg.system.audioserver.loxoneEnabled = true;
        });
      }
      await notifyMiniserverStartup(storedConfig);
      log.info('loxone subsystem enabled');
    }

    // Stop the Loxone subsystem and detach the command engine so :7090 rejects
    // /audio/... again. Idempotent. The rest of the server is untouched.
    async function disableLoxone(persist = true): Promise<void> {
      if (loxoneService) {
        await loxoneService.stop();
        loxoneService = null;
      }
      httpService?.setLoxoneProcessor(null);
      if (persist) {
        await configPort.updateConfig((cfg) => {
          cfg.system.audioserver.loxoneEnabled = false;
        });
      }
      log.info('loxone subsystem disabled');
    }

    browserZoneRegistry = new BrowserZoneRegistry(zoneManager);

    // DLNA/UPnP MediaServer: exposes all browsable content (library, radio,
    // bridges) as ContentDirectory and serves tracks statelessly at
    // /dlna/track/<id>. Gated on content.mediaServer.enabled; its SSDP advertiser
    // is started/stopped alongside the gateway below.
    mediaServer = new MediaServer(
      configPort,
      contentManager,
      contentAdapter,
      engine,
      config.http.port,
      ssdpAdvertiser,
    );

    // Subsonic API: exposes the same browsable content (library, radio, bridges)
    // over the Subsonic REST protocol at /rest/*. Stateless and gated on
    // content.subsonic.enabled, so it needs no lifecycle of its own.
    const subsonicApi = new SubsonicApi(configPort, contentManager, contentAdapter, engine);

    httpService = new HttpService(config.http, {
      onReinitialize: handleReinitialize,
      onSoftRestart: handleSoftRestart,
      onLoxoneToggle: (enabled) => (enabled ? enableLoxone() : disableLoxone()),
      notifier: ports.notifier,
      loxoneNotifier,
      spotifyManagerProvider,
      customRadioStore,
      zoneManager,
      configPort,
      engine,
      streamEvents,
      lineInRegistry,
      lineInMetadataService,
      lineInActivation,
      sendspinLineInService,
      musicAssistantStreamService,
      spotifyInputService,
      snapcastCore,
      squeezeliteCore,
      squeezeliteCli,
      recentsManager,
      favoritesManager,
      groupManager,
      contentManager,
      audioManager,
      zoneAudioPrefs,
      mdnsPort: mdnsService,
      sonnCorePeers,
      alertFiles: alertFilesPort,
      // Attached at runtime via setLoxoneProcessor (enableLoxone), so starts null.
      loxoneProcessor: null,
      connectionRegistry,
      browserZoneRegistry,
      streamProxyRoutes: [
        tidalStreamService.getProxyRoute(),
        deezerStreamService.getProxyRoute(),
        appleMusicStreamService.getProxyRoute(),
        spotifyStreamProxyService.getProxyRoute(),
      ],
      mediaServer,
      subsonic: subsonicApi,
      dlnaInput: dlnaInputService,
    });
    networkService = new NetworkService({
      lineInRegistry,
      snapcastCore,
    });

    await httpService.start();
    await networkService.start();
    // Start the shared SSDP socket, then let the MediaServer register its device.
    // Per-zone renderer devices register via dlnaInputService.syncZones (driven by
    // zoneManager). All share this one advertiser / UDP :1900 socket.
    await ssdpAdvertiser.start();
    await mediaServer.start();

    sendspinServerAdvertiser = new SendspinServerAdvertiser(
      config.http,
      configPort,
      sendspinConnector,
    );
    sonnCoreMdnsService = new SonnCoreMdnsService(config.http, configPort, mdnsService);
    snapcastMdnsService = new SnapcastMdnsService(
      config.http,
      configPort,
      networkService,
      mdnsService,
    );

    mdnsServices.length = 0;
    mdnsServices.push(sendspinServerAdvertiser, sonnCoreMdnsService, snapcastMdnsService);
    mdnsServices.forEach((service) => service.start());
    // Bring the Loxone subsystem up if it's connected. Same path a runtime connect
    // uses; persist=false because the flag is already set. A plain server skips it.
    if (loxoneEnabled) {
      await enableLoxone(false);
    }

    log.info('startup complete');
  }

  async function stopServices(): Promise<void> {
    const log = createLogger('Server');
    const services: LifecycleService[] = [
      // Tear down ephemeral browser zones before the zone manager shutdown so
      // each one's outputs get cleaned up via the standard removeZone path.
      { name: 'browser-zones', stop: async () => browserZoneRegistry?.shutdown() },
      { name: 'zones', stop: () => zoneManager.shutdown() },
    ];
    services.push({ name: 'linein-metadata', stop: async () => lineInMetadataService.stop() });
    services.push({ name: 'sendspin-linein', stop: async () => sendspinLineInService.stop() });
    services.push({ name: 'squeezelite', stop: async () => squeezeliteCore.stop() });
    services.push({ name: 'squeezelite-cli', stop: async () => squeezeliteCli.stop() });

    if (loxoneService) {
      services.push({ name: 'loxone', stop: () => loxoneService!.stop() });
    }
    services.push({
      name: 'mdns',
      stop: async () => {
        mdnsServices.forEach((service) => service.stop());
        mdnsServices.length = 0;
        sonnCorePeers.stop();
        mdnsService.shutdown();
      },
    });
    if (mediaServer) {
      services.push({ name: 'media-server', stop: () => mediaServer!.stop() });
    }
    services.push({
      name: 'dlna-input',
      stop: async () => {
        dlnaInputService.shutdown();
        await ssdpAdvertiser.stop();
      },
    });
    if (networkService) {
      services.push({ name: 'network', stop: () => networkService!.stop() });
    }
    if (httpService) {
      services.push({ name: 'http', stop: () => httpService!.stop() });
    }

    await Promise.all(
      services.map((service) =>
        stopWithTimeout(service.name, service.stop, 6000, log),
      ),
    );

    httpService = null;
    networkService = null;
    sendspinServerAdvertiser = null;
    sonnCoreMdnsService = null;
    snapcastMdnsService = null;
    mediaServer = null;
    loxoneService = null;
  }

  return {
    start: startServices,
    stop: stopServices,
  };
}

async function notifyMiniserverStartup(config: AudioServerConfig): Promise<void> {
  const log = createLogger('Server');
  const miniserverIp = config.system?.miniserver?.ip?.trim();
  const macId = config.system?.audioserver?.macId?.trim().toUpperCase();

  if (!miniserverIp || !macId) {
    log.debug('miniserver startup ping skipped (missing ip/mac)');
    return;
  }

  const section = findServerSection(config.rawAudioConfig?.raw, macId)
    ?? findServerSection(config.rawAudioConfig?.rawString, macId);
  const uuid = normalizeString(section?.uuid);

  if (!uuid) {
    log.debug('miniserver startup ping skipped (missing uuid)', { macId });
    return;
  }

  const url = `http://${miniserverIp}/dev/sps/devicestartup/${encodeURIComponent(uuid)}`;
  const controller = new AbortController();
  const scheduleTimeout = globalThis.setTimeout as typeof setTimeout;
  const timeout = scheduleTimeout(() => controller.abort(), 4000);

  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!response.ok) {
      log.warn('miniserver startup ping failed', { status: response.status, url });
    } else {
      log.info('miniserver startup ping sent', { url });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('miniserver startup ping failed', { message, url });
  } finally {
    clearTimeout(timeout);
  }
}

function findServerSection(raw: unknown, macId: string): Record<string, unknown> | undefined {
  if (!raw || !macId) {
    return undefined;
  }

  const normalizedMacId = macId.trim().toUpperCase();
  let parsed = raw;

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }

  if (!Array.isArray(parsed)) {
    return undefined;
  }

  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const matchKey = Object.keys(entry).find(
      (key) => key.trim().toUpperCase() === normalizedMacId,
    );
    if (matchKey) {
      return (entry as Record<string, unknown>)[matchKey] as Record<string, unknown>;
    }
  }

  return undefined;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
