import type { ZoneConfigEntry, AdminConfig } from '../../../config/configStore';
import type { ZoneEntry } from '../zonemanager';
import type { PlayerStatus } from '../loxoneTypes';
import type { ZoneCapabilityDescriptor, ZoneCapabilityContext } from '../capabilityTypes';

export type ZoneContentCommand =
  | 'serviceplay'
  | 'playlistplay'
  | 'announce'
  | 'queue'
  | 'queueplus'
  | 'queueminus'
  | 'repeat'
  | 'shuffle'
  | 'position';

export interface ZoneContentPlaybackAdapter {
  handles(command: string): boolean;
  execute(command: ZoneContentCommand, payload: unknown): Promise<boolean>;
  cleanup(): Promise<void>;
  describeCapabilities?(context: ZoneCapabilityContext): ZoneCapabilityDescriptor[];
}

export interface ZoneContentFactoryOptions {
  zoneId: number;
  backendId: string;
  zoneConfig: ZoneConfigEntry;
  adminConfig: AdminConfig;
  getZoneOrWarn(): ZoneEntry | undefined;
  pushPlayerEntryUpdate(update: Partial<PlayerStatus>): void;
  acquireClient?(zoneId: number): Promise<{ client: any; release(): Promise<void> }>;
}

export type ZoneContentAdapterFactory = (
  options: ZoneContentFactoryOptions,
) => ZoneContentPlaybackAdapter | undefined;

export interface ZoneContentAdapterDescriptor {
  key: string;
  label: string;
  factory: ZoneContentAdapterFactory;
  defaultBackends?: string[];
  requires?: {
    maPlayerId?: boolean;
  };
  providers?: string[];
  capabilities?: ZoneCapabilityDescriptor[];
}

const registry = new Map<string, ZoneContentAdapterDescriptor>();

export function registerZoneContentAdapter(descriptor: ZoneContentAdapterDescriptor): void {
  registry.set(descriptor.key, descriptor);
}

export function listZoneContentAdapters(): Array<{ key: string; label: string; requiresMaPlayerId: boolean; providers?: string[] }> {
  return Array.from(registry.values()).map(({ key, label, requires, providers }) => ({
    key,
    label,
    requiresMaPlayerId: Boolean(requires?.maPlayerId),
    providers: providers?.slice(),
  }));
}

export function getAdapterDescriptor(key: string): ZoneContentAdapterDescriptor | undefined {
  return registry.get(key);
}

export function getDefaultAdapterForBackend(backendId: string): ZoneContentAdapterDescriptor | undefined {
  for (const descriptor of registry.values()) {
    if (descriptor.defaultBackends?.includes(backendId)) {
      return descriptor;
    }
  }
  return undefined;
}

export function listDefaultContentAdapters(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const descriptor of registry.values()) {
    descriptor.defaultBackends?.forEach((backendId) => {
      map[backendId] = descriptor.key;
    });
  }
  return map;
}

export function createZoneContentAdapter(
  key: string,
  options: ZoneContentFactoryOptions,
): ZoneContentPlaybackAdapter | undefined {
  const descriptor = registry.get(key);
  if (!descriptor) return undefined;
  return descriptor.factory(options);
}
