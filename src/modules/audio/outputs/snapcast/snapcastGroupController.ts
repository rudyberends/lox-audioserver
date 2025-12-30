import { createLogger } from '@/core/logging/logger';
import { getGroupByZone, onGroupChanged } from '@/modules/groups/groupTracker';

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
    onGroupChanged((_event, leader) => {
      const transport = this.transports.get(leader);
      transport?.refresh();
      // Non-leaders will re-evaluate on next play; nothing else needed here.
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

    const leaderZoneId = group.leader;
    const leaderTransport = this.transports.get(leaderZoneId);
    const leaderStreamId = leaderTransport?.baseStreamId ?? String(leaderZoneId);

    // Combine clientIds from leader + members that have transports.
    const combinedClientIds = new Set<string>();
    for (const memberId of new Set([group.leader, ...group.members])) {
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
