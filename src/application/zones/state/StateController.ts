import type { ZoneConfig } from '@/domain/config/types';
import type { ZoneState } from '@/domain/zones/zoneState';

export interface ZoneStateController {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  handleCommand?(command: string, payload?: string): boolean | Promise<boolean>;
}

export type ZoneStateControllerFactoryArgs = {
  zone: ZoneConfig;
  onStatePatch: (zoneId: number, patch: Partial<ZoneState>) => void;
};
