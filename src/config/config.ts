import axios from 'axios';
import logger from '../utils/troxorlogger';
import { asyncCrc32 } from '../utils/crc32utils';
import { setupZones } from '../backend/zone/zonemanager';
import {
  loadAdminConfig,
  saveAdminConfig,
  detectLocalIp,
  AdminConfig,
} from './configStore';

/**
 * Central configuration orchestrator. Persists admin settings, mirrors them into runtime state,
 * and coordinates sync with the Loxone MiniServer and AudioServer.
 */

interface MiniServerConfig {
  ip: string;
  mac: string;
  username: string;
  password: string;
  serial?: string;
}

interface AudioServerConfig {
  name: string;
  paired: boolean;
  ip: string;
  mac: string;
  macID: string;
  uuid?: string;
  musicCFG?: any;
  musicCRC?: string;
}

interface Config {
  miniserver: MiniServerConfig;
  audioserver?: AudioServerConfig;
}

let adminConfig: AdminConfig = loadAdminConfig();

const config: Config = {
  miniserver: {
    ip: adminConfig.miniserver.ip,
    mac: '',
    serial: adminConfig.miniserver.serial,
    username: adminConfig.miniserver.username,
    password: adminConfig.miniserver.password,
  },
};

/**
 * Base AudioServer values used until a pairing payload arrives from the MiniServer.
 */
const DEFAULT_AUDIO_SERVER: AudioServerConfig = {
  name: 'Unconfigured',
  paired: false,
  ip: adminConfig.audioserver.ip || detectLocalIp(),
  mac: '50:4f:94:ff:1b:b3',
  macID: '504F94FF1BB3',
  musicCFG: '[]',
  musicCRC: 'd4cbb29',
};

applyAdminConfig();

/**
 * Normalizes axios errors and logs context-sensitive messages.
 */
const handleAxiosError = (error: unknown) => {
  if (axios.isAxiosError(error) && error.response) {
    const status = error.response.status;
    switch (status) {
      case 401:
        logger.error('[config][getAudioserverConfig] Authentication failed: Unauthorized (401)');
        break;
      case 403:
        logger.error('[config][getAudioserverConfig] Authentication failed: Forbidden (403)');
        break;
      default:
        logger.error(`[config][getAudioserverConfig] Request failed with status: ${status}`);
    }
  } else if (error instanceof Error) {
    logger.error('Error fetching audio server config:', error.message);
  } else {
    logger.error('Error fetching audio server config: Unknown error');
  }
};

/**
 * Fetches the MiniServer Music.json payload that describes known AudioServers.
 */
const downloadAudioServerConfig = async (): Promise<any> => {
  if (!config.miniserver.ip) {
    logger.warn('[config][downloadAudioServerConfig] MINISERVER_IP not set; skipping download.');
    return null;
  }
  try {
    logger.info(
      `[config][downloadAudioServerConfig] Fetching AudioServer config from Loxone MiniServer [${config.miniserver.ip}]`
    );

    const encodedBase64Token = Buffer.from(`${config.miniserver.username}:${config.miniserver.password}`).toString('base64');
    const authorization = `Basic ${encodedBase64Token}`;

    const response = await axios({
      url: `http://${config.miniserver.ip}/dev/fsget/prog/Music.json`,
      method: 'get',
      headers: { Authorization: authorization },
    });

    return response.data;
  } catch (error) {
    handleAxiosError(error);
    throw new Error('Failed to download AudioServer configuration');
  }
};

/**
 * Validates and merges the downloaded AudioServer definition into the runtime config.
 */
const processAudioServerConfig = async (audioServerConfigData: any): Promise<AudioServerConfig | null> => {
  try {
    const newMusicCRC = await asyncCrc32(JSON.stringify(audioServerConfigData));

    if (newMusicCRC === config.audioserver?.musicCRC) {
      logger.info('[config][processAudioServerConfig] No changes detected in AudioServer config.');
      return config.audioserver || DEFAULT_AUDIO_SERVER;
    }

    const audioServer: AudioServerConfig = {
      ...DEFAULT_AUDIO_SERVER,
      musicCFG: audioServerConfigData,
      musicCRC: newMusicCRC,
    };

    if (!audioServer.musicCFG || Object.keys(audioServer.musicCFG).length === 0) {
      logger.error('[config][processAudioServerConfig] No AudioServer found in downloaded configuration.');
      logger.error('[config][processAudioServerConfig] Awaiting MiniServer pairing process.');
      return null;
    }

    audioServer.paired = true;

    // Store the freshly processed configuration so downstream modules (e.g. ZoneManager) see the latest data.
    config.audioserver = audioServer;

    for (const [, value] of Object.entries(audioServer.musicCFG)) {
      const audioServerEntry = value as { [key: string]: { master: string; name: string; uuid: string } };

      if (audioServerEntry[audioServer.macID]) {
        const masterSerial = audioServerEntry[audioServer.macID].master;
        config.miniserver.mac = masterSerial;
        config.miniserver.serial = masterSerial;
        if (adminConfig.miniserver.serial !== masterSerial) {
          adminConfig.miniserver.serial = masterSerial;
          saveAdminConfig(adminConfig);
        }
        audioServer.name = audioServerEntry[audioServer.macID].name;
        audioServer.uuid = audioServerEntry[audioServer.macID].uuid;
        logger.info(`[config][processAudioServerConfig] Paired AudioServer found [${audioServer.name}]`);
        logger.info('[config][processAudioServerConfig] Requesting Zone initialization from Zone Manager');
        await setupZones();
      }
    }

    return audioServer;
  } catch (error) {
    logger.error('Error processing AudioServer config:', error instanceof Error ? error.message : 'Unknown error');
    return null;
  }
};

/**
 * Notifies the MiniServer that the AudioServer finished bootstrapping.
 */
const informMiniServer = async (authorization: string): Promise<void> => {
  try {
    if (!config.audioserver?.uuid) return;
    await axios({
      url: `http://${config.miniserver.ip}/dev/sps/devicestartup/${config.audioserver.uuid}`,
      method: 'get',
      headers: { Authorization: authorization },
    });
    logger.info('[config][informMiniServer] AudioServer is ready and has informed the MiniServer.');
  } catch (error) {
    logger.error('Error informing the MiniServer:', error instanceof Error ? error.message : 'Unknown error');
  }
};

/**
 * Bootstraps runtime configuration by downloading, processing, and persisting state.
 */
const initializeConfig = async () => {
  try {
    const audioServerConfigData = await downloadAudioServerConfig();
    let audioServerConfig: AudioServerConfig | null = null;
    if (audioServerConfigData) {
      audioServerConfig = await processAudioServerConfig(audioServerConfigData);
    }

    config.audioserver = audioServerConfig || DEFAULT_AUDIO_SERVER;

    if (!config.audioserver.paired) {
      logger.warn('[initializeConfig] AudioServer is not paired yet. Waiting for Miniserver pairing.');
      return;
    }

    if (config.miniserver.ip && config.miniserver.username && config.miniserver.password) {
      const encodedBase64Token = Buffer.from(`${config.miniserver.username}:${config.miniserver.password}`).toString('base64');
      const authorization = `Basic ${encodedBase64Token}`;
      await informMiniServer(authorization);
    } else {
      logger.warn('[initializeConfig] Miniserver credentials incomplete; skipping device startup call.');
    }
  } catch (error) {
    logger.error('[initializeConfig] Failed to initialize configuration:', error instanceof Error ? error.message : 'Unknown error');
    config.audioserver = DEFAULT_AUDIO_SERVER;
  }
};

/**
 * Reloads admin configuration from disk and reinitializes runtime state.
 */
const reloadConfiguration = async () => {
  adminConfig = loadAdminConfig();
  applyAdminConfig();
  await initializeConfig();
};

/**
 * Applies persisted admin settings to the in-memory config and environment variables.
 */
function applyAdminConfig() {
  if (!adminConfig.logging) {
    adminConfig.logging = { consoleLevel: 'info', fileLevel: 'none' };
  }
  if (!adminConfig.mediaProvider) {
    adminConfig.mediaProvider = { type: '', options: {} };
  }

  config.miniserver.ip = adminConfig.miniserver.ip || '';
  config.miniserver.username = adminConfig.miniserver.username || '';
  config.miniserver.password = adminConfig.miniserver.password || '';
  config.miniserver.serial = adminConfig.miniserver.serial || '';

  DEFAULT_AUDIO_SERVER.ip = adminConfig.audioserver.ip || detectLocalIp();
  if (!config.audioserver) {
    config.audioserver = { ...DEFAULT_AUDIO_SERVER };
  } else {
    config.audioserver.ip = DEFAULT_AUDIO_SERVER.ip;
  }
  process.env.AUDIOSERVER_IP = config.audioserver.ip;

  if (adminConfig.mediaProvider?.type) {
    process.env.MEDIA_PROVIDER = adminConfig.mediaProvider.type;
  } else {
    delete process.env.MEDIA_PROVIDER;
  }

  Object.keys(process.env)
    .filter((key) => key.startsWith('MEDIA_PROVIDER_'))
    .forEach((key) => delete process.env[key]);

  Object.entries(adminConfig.mediaProvider?.options ?? {}).forEach(([key, value]) => {
    if (value) {
      process.env[`MEDIA_PROVIDER_${key}`] = value;
    }
  });
}

/**
 * Returns the last cached admin configuration.
 */
function getAdminConfig(): AdminConfig {
  return adminConfig;
}

/**
 * Persists new admin settings and reapplies them to the runtime environment.
 */
function updateAdminConfig(newConfig: AdminConfig): void {
  adminConfig = newConfig;
  saveAdminConfig(adminConfig);
  applyAdminConfig();
}

export { config, initializeConfig, reloadConfiguration, processAudioServerConfig, getAdminConfig, updateAdminConfig };
