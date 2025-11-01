import type { MiniServerConfig } from './miniServerConfig';
import type { AudioServerConfig } from './audioServerConfig';
import type { ZoneConfigEntry } from './zoneConfig';
import type { LoggingConfig } from './loggingConfig';
import type { MediaProviderConfig } from './mediaProviderConfig';
import { adminHttpConfig } from './adminHttpConfig';

export interface SystemConfig {
  miniserver: MiniServerConfig;
  audioserver: AudioServerConfig;
  zones: ZoneConfigEntry[];
  mediaProvider: MediaProviderConfig;
  logging: LoggingConfig;
  adminHttp: adminHttpConfig;
}