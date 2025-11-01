import type { ZoneStateMapper } from '../types/zoneStateMapper';
import type { ZoneCommandMapper } from '../types/zoneCommandMapper';

export class NullStateMapper implements ZoneStateMapper {
  readonly type = 'null';
  async initialize(): Promise<void> {}
  async destroy(): Promise<void> {}
  onUpdate(): void {}
}

export class NullCommandMapper implements ZoneCommandMapper {
  readonly type = 'null';
  async handle(): Promise<boolean> {
    return false;
  }
}