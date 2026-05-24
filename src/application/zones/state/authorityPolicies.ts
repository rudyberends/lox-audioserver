import type { ZoneConfig } from '@/domain/config/types';
import type { LoxoneZoneState } from '@/domain/loxone/types';

export type ZoneStateControllerId = 'internal' | string;

export function resolveZoneStateControllerId(zone: ZoneConfig): ZoneStateControllerId {
  const raw = typeof zone.state?.controller === 'string' ? zone.state.controller.trim().toLowerCase() : '';
  if (!raw) return 'internal';
  const normalized = raw.replace(/[\s_-]+/g, '');
  if (normalized === 'beolink') return 'beolink';
  if (normalized === 'sonos') return 'sonos';
  if (normalized === 'musicassistant' || normalized === 'ma') return 'musicassistant';
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
  // In Music Assistant sink mode the MA player owns the audio path. When a
  // local lox-audio session is active (we're streaming our own content into
  // MA) the local session is authoritative for time/title/duration/cover —
  // MA's queue treats our URL as a radio stream and reports unreliable timing.
  // We only forward volume from MA in that case.
  musicassistant: {
    ownsVolumeState: true,
    commandAuthorityWhenLocalSessionActive: () => true,
    patchAuthorityWhenLocalSessionActive: (patch) => {
      const out: Partial<LoxoneZoneState> = {};
      if (typeof patch.volume === 'number' && Number.isFinite(patch.volume)) {
        out.volume = patch.volume;
      }
      if (typeof patch.mode === 'string') {
        out.mode = patch.mode;
      }
      return Object.keys(out).length > 0 ? out : null;
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
