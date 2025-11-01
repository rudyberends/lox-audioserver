import type { ZoneState } from './zoneStateTypes';

export interface ZoneStateMapper {
  readonly type: string;

  initialize(): Promise<void>;
  destroy(): Promise<void>;

  onUpdate(cb: (update: Partial<ZoneState>) => void): void;

  getMetadata?(): Record<string, any>;
}