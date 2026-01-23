import type { StoragePort } from '@/ports/StoragePort';
import type { NotifierPort } from '@/ports/NotifierPort';
import { StorageAdapter } from '@/adapters/storage/StorageAdapter';
import type { ConfigPort } from '@/ports/ConfigPort';
import { ConfigAdapter } from '@/adapters/config/ConfigAdapter';
import { ConfigRepository } from '@/application/config/configRepository';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';

export type RuntimePorts = {
  storage: StoragePort;
  notifier: NotifierPort;
  config: ConfigPort;
};

export function createRuntimePorts(deps: { notifier: NotifierPort }): RuntimePorts {
  const storage = new StorageAdapter();
  const configRepository = new ConfigRepository(storage);
  return {
    storage,
    notifier: deps.notifier,
    config: new ConfigAdapter(configRepository),
  };
}

export function createZoneManagerProxy(
  requireZoneManager: () => ZoneManagerFacade,
): OutputPorts['zoneManager'] {
  return {
    getZoneState: (zoneId) => requireZoneManager().getZoneState(zoneId),
    handleCommand: (zoneId, command, value) => {
      requireZoneManager().handleCommand(zoneId, command, value);
    },
    setRepeatMode: (zoneId, mode) => {
      requireZoneManager().setRepeatMode(zoneId, mode);
    },
    setShuffle: (zoneId, enabled) => {
      requireZoneManager().setShuffle(zoneId, enabled);
    },
  };
}
