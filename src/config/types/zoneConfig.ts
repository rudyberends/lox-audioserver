export interface ZoneVolumeConfig {
  default?: number;
  max?: number;
  alarm?: number;
  fire?: number;
  bell?: number;
  buzzer?: number;
  tts?: number;
}

export interface ZoneConfigEntry {
  id: number;
  name: string;
  adapter: {
    type: string;
    parameters: Record<string, any>;
  };
  volumes?: ZoneVolumeConfig;
  source?: string;
  sourceSerial?: string;
}
