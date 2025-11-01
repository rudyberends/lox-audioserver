export interface AudioServerConfig {
  name: string;
  paired: boolean;
  ip: string;
  mac: string;
  macId: string;
  uuid?: string;
  musicCrc: string;
  extensions?: ExtensionDescriptor[];
  lastUpdate?: number;
}

export type ExtensionDescriptor = {
  version: string;
  mac: string;
  serial: string;
  blinkpos?: number;
  type?: number;
  subtype?: number;
  btenable?: boolean;
  name?: string;
};