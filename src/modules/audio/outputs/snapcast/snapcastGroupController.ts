import { createLogger } from '@/core/logging/logger';
import { getGroupByZone, onGroupChanged } from '@/modules/groups/groupTracker';
import { audioManager } from '@/modules/audio/audioManager';

type TransportInfo = {
  zoneId: number;
  baseStreamId: string;
  baseClientIds: string[];
  refresh: () => void;
};

type GroupPlan = {
  shouldPlay: boolean;
  streamId: string;
  clientIds: string[];
  leaderZoneId: number;
  isLeader: boolean;
};

/**
 * Minimal coordinator to align Snapcast streams with the app's group model.
 * We keep a single stream per group (the leader's streamId) and map all member clientIds to it.
 * Non-leader transports skip playback when grouped.
 */
class SnapcastGroupController {
  private readonly log = createLogger('Transport', 'SnapcastGroups');
  private readonly transports = new Map<number, TransportInfo>();

  constructor() {
    onGroupChanged(() => {
      // Group changes can affect any snapcast transport; refresh all to avoid stale mappings.
      for (const transport of this.transports.values()) {
        transport.refresh();
      }
    });
  }

  public register(info: TransportInfo): void {
    this.transports.set(info.zoneId, info);
  }

  public unregister(zoneId: number): void {
    this.transports.delete(zoneId);
  }

  public buildPlan(zoneId: number, baseStreamId: string, baseClientIds: string[]): GroupPlan {
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
    let leaderTransport = this.transports.get(leaderZoneId);
    const leaderSession = audioManager.getSession(leaderZoneId);
    if (!leaderSession) {
      for (const memberId of memberIds) {
        const candidateSession = audioManager.getSession(memberId);
        const candidate = this.transports.get(memberId);
        if (candidate && candidateSession) {
          leaderZoneId = memberId;
          leaderTransport = candidate;
          break;
        }
      }
    }
    if (!leaderTransport) {
      for (const memberId of memberIds) {
        const candidate = this.transports.get(memberId);
        if (candidate) {
          leaderZoneId = memberId;
          leaderTransport = candidate;
          break;
        }
      }
    }
    if (!leaderTransport) {
      return {
        shouldPlay: true,
        streamId: baseStreamId,
        clientIds: baseClientIds,
        leaderZoneId: zoneId,
        isLeader: true,
      };
    }
    const leaderStreamId = leaderTransport.baseStreamId;

    // Combine clientIds from leader + members that have transports.
    const combinedClientIds = new Set<string>();
    for (const memberId of memberIds) {
      const t = this.transports.get(memberId);
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

export const snapcastGroupController = new SnapcastGroupController();
