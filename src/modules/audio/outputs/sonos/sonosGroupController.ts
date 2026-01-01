import { createLogger } from '@/core/logging/logger';
import { getGroupByZone, onGroupChanged } from '@/modules/groups/groupTracker';
import type { GroupRecord } from '@/modules/groups/types/groupRecord';

export interface SonosGroupParticipant {
  getZoneId(): number;
  ensureDeviceInfo(): Promise<string | null>;
  getDeviceUdn(): string | null;
  getS2GroupId(): string | null;
  joinToLeader(leaderUdn: string): Promise<boolean>;
  joinToLeaderS2(groupId: string): Promise<boolean>;
  leaveGroup(): Promise<void>;
}

class SonosGroupController {
  private readonly log = createLogger('Transport', 'SonosGroups');
  private readonly transports = new Map<number, SonosGroupParticipant>();
  private readonly lastMembersByLeader = new Map<number, Set<number>>();

  constructor() {
    onGroupChanged((event, leader, record) => {
      if (event === 'remove' && record) {
        void this.handleGroupRemoved(record);
        return;
      }
      if ((event === 'new' || event === 'update') && record) {
        void this.syncGroup(record);
      }
    });
  }

  public register(zoneId: number, transport: SonosGroupParticipant): void {
    this.transports.set(zoneId, transport);
  }

  public unregister(zoneId: number): void {
    this.transports.delete(zoneId);
    this.lastMembersByLeader.delete(zoneId);
  }

  public async tryJoinLeader(transport: SonosGroupParticipant): Promise<boolean> {
    const group = getGroupByZone(transport.getZoneId());
    if (!group || group.leader === transport.getZoneId()) {
      return false;
    }
    const leader = this.transports.get(group.leader);
    if (!leader) {
      return false;
    }
    const leaderUdn = await leader.ensureDeviceInfo();
    if (leaderUdn) {
      const leaderS2GroupId = leader.getS2GroupId();
      if (leaderS2GroupId) {
        return transport.joinToLeaderS2(leaderS2GroupId);
      }
      return transport.joinToLeader(leaderUdn);
    }
    return false;
  }

  public async syncGroupMembers(leader: SonosGroupParticipant): Promise<void> {
    const group = getGroupByZone(leader.getZoneId());
    if (!group || group.leader !== leader.getZoneId()) {
      return;
    }
    const leaderUdn = await leader.ensureDeviceInfo();
    const leaderS2GroupId = leader.getS2GroupId();
    if (!leaderUdn && !leaderS2GroupId) {
      return;
    }
    const members = new Set<number>(group.members);
    members.delete(group.leader);
    for (const memberId of members) {
      const transport = this.transports.get(memberId);
      if (!transport) continue;
      try {
        if (leaderS2GroupId) {
          await transport.joinToLeaderS2(leaderS2GroupId);
        } else if (leaderUdn) {
          await transport.joinToLeader(leaderUdn);
        }
      } catch (err) {
        this.log.debug('sonos join failed', {
          leader: group.leader,
          member: memberId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async syncGroup(record: GroupRecord): Promise<void> {
    const leader = this.transports.get(record.leader);
    if (!leader) {
      return;
    }
    const leaderUdn = await leader.ensureDeviceInfo();
    const leaderS2GroupId = leader.getS2GroupId();
    if (!leaderUdn && !leaderS2GroupId) {
      return;
    }
    const members = new Set<number>(record.members);
    members.delete(record.leader);
    const previous = this.lastMembersByLeader.get(record.leader) ?? new Set<number>();
    this.lastMembersByLeader.set(record.leader, members);

    for (const memberId of members) {
      if (previous.has(memberId)) {
        continue;
      }
      const transport = this.transports.get(memberId);
      if (!transport) continue;
      try {
        if (leaderS2GroupId) {
          await transport.joinToLeaderS2(leaderS2GroupId);
        } else if (leaderUdn) {
          await transport.joinToLeader(leaderUdn);
        }
      } catch (err) {
        this.log.debug('sonos join failed', {
          leader: record.leader,
          member: memberId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    for (const memberId of previous) {
      if (members.has(memberId)) {
        continue;
      }
      const transport = this.transports.get(memberId);
      if (!transport) continue;
      try {
        await transport.leaveGroup();
      } catch (err) {
        this.log.debug('sonos leave failed', {
          leader: record.leader,
          member: memberId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async handleGroupRemoved(record: GroupRecord): Promise<void> {
    const previous = this.lastMembersByLeader.get(record.leader);
    this.lastMembersByLeader.delete(record.leader);
    const members = previous ?? new Set<number>(record.members);
    members.delete(record.leader);
    for (const memberId of members) {
      const transport = this.transports.get(memberId);
      if (!transport) continue;
      try {
        await transport.leaveGroup();
      } catch (err) {
        this.log.debug('sonos leave failed', {
          leader: record.leader,
          member: memberId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

export const sonosGroupController = new SonosGroupController();
