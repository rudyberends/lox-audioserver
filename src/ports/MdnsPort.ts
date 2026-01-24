export type MdnsServiceRecord = {
  name?: string;
  host?: string;
  port: number;
  addresses?: string[];
  txt?: Record<string, unknown>;
  type?: string;
  protocol?: string;
};

export type MdnsPublishOptions = {
  name?: string;
  type: string;
  protocol?: 'tcp' | 'udp';
  port: number;
  host?: string;
  txt?: Record<string, string>;
};

export type MdnsBrowseOptions = {
  type: string;
  protocol?: 'tcp' | 'udp';
};

export type MdnsRegistration = {
  stop: () => void;
};

export type MdnsBrowser = {
  stop: () => void;
};

export interface MdnsPort {
  publish: (options: MdnsPublishOptions) => MdnsRegistration;
  browse: (options: MdnsBrowseOptions, onService: (service: MdnsServiceRecord) => void) => MdnsBrowser;
  shutdown: () => void;
}
