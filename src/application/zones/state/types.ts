import type { ZoneConfig } from '@/domain/config/types';
import type { LoxoneZoneState } from '@/domain/loxone/types';

export type ZoneStateControllerId = 'internal' | string;

export function resolveZoneStateControllerId(zone: ZoneConfig): ZoneStateControllerId {
  const raw = typeof zone.state?.controller === 'string' ? zone.state.controller.trim().toLowerCase() : '';
  if (!raw) return 'internal';
  const normalized = raw.replace(/[\s_-]+/g, '');
  if (normalized === 'beolink') return 'beolink';
  if (normalized === 'sonos') return 'sonos';
  if (normalized === 'internal') return 'internal';
  return raw;
}

type StateControllerAuthorityPolicy = {
  ownsVolumeState?: boolean;
  commandAuthorityWhenLocalSessionActive?: (command: string) => boolean;
  patchAuthorityWhenLocalSessionActive?: (
    patch: Partial<LoxoneZoneState>,
  ) => Partial<LoxoneZoneState> | null;
};

const isVolumeCommand = (command: string): boolean => {
  const normalized = command.trim().toLowerCase();
  return normalized === 'volume' || normalized === 'volume_set';
};

const CONTROLLER_AUTHORITY_POLICIES: Record<string, StateControllerAuthorityPolicy> = {
  // Initial policy: external controller keeps authority on volume while local session is active.
  beolink: {
    ownsVolumeState: true,
    commandAuthorityWhenLocalSessionActive: isVolumeCommand,
    patchAuthorityWhenLocalSessionActive: (patch) => {
      const volume = patch.volume;
      if (typeof volume === 'number' && Number.isFinite(volume)) {
        return { volume };
      }
      return null;
    },
  },
};

export function shouldUseStateControllerForCommand(
  controllerId: string,
  hasActiveLocalSession: boolean,
  command: string,
): boolean {
  if (controllerId === 'internal') return false;
  if (!hasActiveLocalSession) return true;
  const policy = CONTROLLER_AUTHORITY_POLICIES[controllerId];
  return policy?.commandAuthorityWhenLocalSessionActive?.(command) === true;
}

export function filterAuthoritativePatchWhileLocalSessionActive(
  controllerId: string,
  patch: Partial<LoxoneZoneState>,
): Partial<LoxoneZoneState> | null {
  if (controllerId === 'internal') {
    return patch;
  }
  const policy = CONTROLLER_AUTHORITY_POLICIES[controllerId];
  return policy?.patchAuthorityWhenLocalSessionActive?.(patch) ?? null;
}

export function isVolumeOwnedByStateController(controllerId: string): boolean {
  if (controllerId === 'internal') return false;
  const policy = CONTROLLER_AUTHORITY_POLICIES[controllerId];
  return policy?.ownsVolumeState === true;
}
