import type { ZoneConfigEntry } from '../../config/configStore';

export type ZoneCapabilityKind = 'control' | 'content' | 'grouping' | 'alerts' | 'tts';

export type ZoneCapabilityStatus = 'none' | 'native' | 'adapter';

export interface ZoneCapabilityDescriptor {
  kind: ZoneCapabilityKind;
  status: ZoneCapabilityStatus;
  detail?: string;
  source?: 'backend' | 'adapter';
}

export interface ZoneCapabilityContext {
  zoneConfig?: ZoneConfigEntry;
  zoneState?: unknown;
}

export const ALL_ZONE_CAPABILITY_KINDS: ZoneCapabilityKind[] = ['control', 'content', 'grouping', 'alerts', 'tts'];
