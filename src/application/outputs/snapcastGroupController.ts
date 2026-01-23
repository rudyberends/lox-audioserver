import { createLogger } from '@/shared/logging/logger';
import { getGroupByZone, onGroupChanged } from '@/application/groups/groupTracker';
import type { AudioManager } from '@/application/playback/audioManager';

export type SnapcastGroupRegistration = {
  zoneId: number;
  baseStreamId: string;
  baseClientIds: string[];
  refresh: () => void;
};

export type SnapcastGroupPlan = {
  shouldPlay: boolean;
  streamId: string;
  clientIds: string[];
  leaderZoneId: number;
  isLeader: boolean;
};

export type SnapcastGroupCoordinator = {
  register: (info: SnapcastGroupRegistration) => void;
  unregister: (zoneId: number) => void;
  buildPlan: (
    zoneId: number,
    baseStreamId: string,
    baseClientIds: string[],
  ) => SnapcastGroupPlan;
};

/**
 * Minimal coordinator to align Snapcast streams with the app's group model.
 * We keep a single stream per group (the leader's streamId) and map all member clientIds to it.
 * Non-leader outputs skip playback when grouped.
 */
class SnapcastGroupController {
  private readonly log = createLogger('Output', 'SnapcastGroups');
  private readonly outputs = new Map<number, SnapcastGroupRegistration>();
  private readonly audioManager: AudioManager;

  constructor(audioManager: AudioManager) {
    this.audioManager = audioManager;
    onGroupChanged(() => {
      // Group changes can affect any snapcast output; refresh all to avoid stale mappings.
      for (const output of this.outputs.values()) {
        output.refresh();
      }
    });
  }

  public register(info: SnapcastGroupRegistration): void {
    this.outputs.set(info.zoneId, info);
  }

  public unregister(zoneId: number): void {
    this.outputs.delete(zoneId);
  }

  public buildPlan(zoneId: number, baseStreamId: string, baseClientIds: string[]): SnapcastGroupPlan {
    const group = getGroupByZone(zoneId);
    if (!group || group.members.length === 0) {
      return {
        shouldPlay: true,
        streamId: baseStreamId,
        clientIds: baseClientIds,
        leaderZoneId: zoneId,
        isLeader: true,
      };
    }

    const memberIds = new Set([group.leader, ...group.members]);
    let leaderZoneId = group.leader;
    let leaderOutput = this.outputs.get(leaderZoneId);
    const leaderSession = this.audioManager.getSession(leaderZoneId);
    if (!leaderSession) {
      for (const memberId of memberIds) {
        const candidateSession = this.audioManager.getSession(memberId);
        const candidate = this.outputs.get(memberId);
        if (candidate && candidateSession) {
          leaderZoneId = memberId;
          leaderOutput = candidate;
          break;
        }
      }
    }
    if (!leaderOutput) {
      for (const memberId of memberIds) {
        const candidate = this.outputs.get(memberId);
        if (candidate) {
          leaderZoneId = memberId;
          leaderOutput = candidate;
          break;
        }
      }
    }
    if (!leaderOutput) {
      return {
        shouldPlay: true,
        streamId: baseStreamId,
        clientIds: baseClientIds,
        leaderZoneId: zoneId,
        isLeader: true,
      };
    }
    const leaderStreamId = leaderOutput.baseStreamId;

    // Combine clientIds from leader + members that have outputs.
    const combinedClientIds = new Set<string>();
    for (const memberId of memberIds) {
      const t = this.outputs.get(memberId);
      if (!t) continue;
      t.baseClientIds.forEach((id) => combinedClientIds.add(id));
    }

    if (leaderZoneId !== zoneId) {
      this.log.debug('snapcast grouped member skipping local stream', {
        zoneId,
        leaderZoneId,
      });
      return {
        shouldPlay: false,
        streamId: leaderStreamId,
        clientIds: Array.from(combinedClientIds),
        leaderZoneId,
        isLeader: false,
      };
    }

    return {
      shouldPlay: true,
      streamId: leaderStreamId,
      clientIds: Array.from(combinedClientIds),
      leaderZoneId,
      isLeader: true,
    };
  }
}

export function createSnapcastGroupController(audioManager: AudioManager): SnapcastGroupCoordinator {
  return new SnapcastGroupController(audioManager);
}
