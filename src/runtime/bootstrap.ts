import { loadConfig } from '@/config';
import { createLogger, logManager } from '@/shared/logging/logger';
import { createContentManager } from '@/adapters/content/contentManager';
import { createContentAdapter } from '@/adapters/content/ContentAdapter';
import { CustomRadioStore } from '@/adapters/content/providers/customRadioStore';
import { SpotifyServiceManagerProvider } from '@/adapters/content/providers/spotifyServiceManager';
import { AppleMusicStreamService } from '@/adapters/content/providers/applemusic/appleMusicStreamService';
import { AppleMusicStreamResolver } from '@/adapters/content/providers/applemusic/appleMusicStreamResolver';
import { DeezerStreamService } from '@/adapters/content/providers/deezer/deezerStreamService';
import { DeezerStreamResolver } from '@/adapters/content/providers/deezer/deezerStreamResolver';
import { TidalStreamService } from '@/adapters/content/providers/tidal/tidalStreamService';
import { TidalStreamResolver } from '@/adapters/content/providers/tidal/tidalStreamResolver';
import { YtMusicStreamService } from '@/adapters/content/providers/ytmusic/ytmusicStreamService';
import { YtMusicStreamResolver } from '@/adapters/content/providers/ytmusic/ytmusicStreamResolver';
import { HttpService } from '@/adapters/http';
import { LoxoneHttpService } from '@/adapters/loxone/http';
import { createInputsAdapter } from '@/adapters/inputs/InputsAdapter';
import { createOutputsAdapter } from '@/adapters/outputs/OutputsAdapter';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';
import { EngineAdapter } from '@/adapters/engine/EngineAdapter';
import { AudioStreamEngine } from '@/engine/audioStreamEngine';
import { createZoneManager, type ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { AudioServerConfig } from '@/domain/config/types';
import { PlaybackService } from '@/application/playback/PlaybackService';
import { AirplayInputService } from '@/adapters/inputs/airplay/airplayInputService';
import { LineInMetadataService } from '@/adapters/inputs/linein/lineInMetadataService';
import { SendspinLineInService } from '@/adapters/inputs/linein/sendspinLineInService';
import { MusicAssistantStreamService } from '@/adapters/inputs/musicassistant/musicAssistantStreamService';
import { MusicAssistantInputService } from '@/adapters/inputs/musicassistant/musicAssistantInputService';
import { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import { LineInIngestRegistry } from '@/adapters/inputs/linein/lineInIngestRegistry';
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
import { LoxAudioMdnsService } from '@/adapters/discovery/loxAudioMdnsService';
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
  const loxoneNotifier = new LoxoneWsNotifier(connectionRegistry, groupTracker);
  const ports = createRuntimePorts({ notifier: new LoxoneNotifierAdapter(loxoneNotifier) });
  const configPort = ports.config;
  const audioStreamEngine = new AudioStreamEngine();
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
  const appleMusicStreamService = new AppleMusicStreamService(outputHandlersProxy.onOutputError, configPort);
  const deezerStreamService = new DeezerStreamService(outputHandlersProxy.onOutputError, configPort);
  const tidalStreamService = new TidalStreamService(outputHandlersProxy.onOutputError, configPort);
  const ytmusicStreamService = new YtMusicStreamService(outputHandlersProxy.onOutputError, configPort);
  const appleMusicStreamResolver = new AppleMusicStreamResolver(appleMusicStreamService);
  const deezerStreamResolver = new DeezerStreamResolver(deezerStreamService);
  const tidalStreamResolver = new TidalStreamResolver(tidalStreamService);
  const ytmusicStreamResolver = new YtMusicStreamResolver(ytmusicStreamService);
  const engine = new EngineAdapter(audioStreamEngine);
  const lineInRegistry = new LineInIngestRegistry();
  const mdnsService = new MdnsService();
  const sendspinConnector = new SendspinClientConnector(mdnsService);
  let sendspinServerAdvertiser: SendspinServerAdvertiser | null = null;
  let loxAudioMdnsService: LoxAudioMdnsService | null = null;
  let snapcastMdnsService: SnapcastMdnsService | null = null;
  const mdnsServices: MdnsLifecycleService[] = [];
  const streamEvents = new StreamEvents();
  const serverHeartbeat = new ServerHeartbeat(connectionRegistry);
  const sendspinHookRegistry = new SendspinHookRegistry();
  const sendspinLineInService = new SendspinLineInService(lineInRegistry, sendspinHookRegistry, configPort);
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
  const spotifyInputService = new SpotifyInputService(
    outputHandlersProxy.onOutputError,
    configPort,
    spotifyManagerProvider,
    spotifyDeviceRegistry,
    stopAirplaySession,
  );
  airplayInputService = new AirplayInputService((zoneId, reason) => {
    spotifyInputService.stopActiveSession(zoneId, reason);
  });
  if (!airplayInputService) {
    throw new Error('airplay input service not initialized');
  }
  const inputsAdapter = createInputsAdapter({
    airplay: airplayInputService,
    spotify: spotifyInputService,
    musicAssistant: musicAssistantInputService,
    sendspinLineIn: sendspinLineInService,
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

    log.info('bootstrapping audio server', {
      env: config.env.nodeEnv,
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

    httpService = new HttpService(config.http, {
      onReinitialize: handleReinitialize,
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
    });
    networkService = new NetworkService({
      lineInRegistry,
      snapcastCore,
    });
    loxoneService = new LoxoneHttpService(config.loxone, {
      host: config.env.hostname,
      onRestart: handleSoftRestart,
      notifier: ports.notifier,
      loxoneNotifier,
      configService: loxoneConfigService,
      connectionRegistry,
      serverHeartbeat,
      zoneManager,
      configPort,
      lineInRegistry,
      sendspinLineInService,
      spotifyInputService,
      recentsManager,
      favoritesManager,
      groupManager,
      groupTracker,
      contentManager,
    });

    await httpService.start();
    await networkService.start();

    sendspinServerAdvertiser = new SendspinServerAdvertiser(
      config.http,
      configPort,
      sendspinConnector,
    );
    loxAudioMdnsService = new LoxAudioMdnsService(config.http, configPort, mdnsService);
    snapcastMdnsService = new SnapcastMdnsService(
      config.http,
      configPort,
      networkService,
      mdnsService,
    );

    mdnsServices.length = 0;
    mdnsServices.push(sendspinServerAdvertiser, loxAudioMdnsService, snapcastMdnsService);
    mdnsServices.forEach((service) => service.start());
    await loxoneService.start();
    await notifyMiniserverStartup(storedConfig);

    log.info('startup complete');
  }

  async function stopServices(): Promise<void> {
    const log = createLogger('Server');
    const services: LifecycleService[] = [
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
        mdnsService.shutdown();
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
    loxAudioMdnsService = null;
    snapcastMdnsService = null;
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
