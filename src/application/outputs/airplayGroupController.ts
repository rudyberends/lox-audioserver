import { getGroupByZone } from '@/application/groups/groupTracker';
import { createLogger } from '@/shared/logging/logger';
import type { AudioManager } from '@/application/playback/audioManager';

/**
 * A grouped AirPlay output. With node-libraop every device is an independent
 * RAOP sender, so multiroom is "one shared PCM stream, N senders": the leader
 * owns the engine stream and each member feeds its own sender from it. (Members
 * start as close together as the event loop allows; sample-accurate sync would
 * require exposing a shared `ntpstart` anchor in node-libraop — a follow-up.)
 */
export type AirplayGroupParticipant = {
  getZoneId(): number;
  getCurrentVolume(): number;
  isRunning(): boolean;
  getSharedStream(): NodeJS.ReadableStream | null;
  startFromLeaderStream(stream: NodeJS.ReadableStream, volume: number): Promise<void>;
  stopLocal(): Promise<void>;
  markAttachedToLeader(leaderId: number): void;
  clearLeaderAttachment(): void;
  isAttachedToLeader(leaderId: number): boolean;
  getAttachedLeaderId(): number | null;
};

export type AirplayGroupCoordinator = {
  register: (zoneId: number, output: AirplayGroupParticipant) => void;
  unregister: (zoneId: number) => void;
  tryJoinLeader: (output: AirplayGroupParticipant) => Promise<boolean>;
  syncGroupMembers: (leader: AirplayGroupParticipant) => Promise<void>;
  stopGroupMembers: (leaderZoneId: number, members: number[]) => Promise<void>;
  detachMember: (member: AirplayGroupParticipant) => Promise<void>;
  syncCurrentGroup: (leaderZoneId: number) => Promise<void>;
  onLeaderStopped: (leaderZoneId: number) => void;
};

class AirplayGroupController {
  private readonly log = createLogger('Output', 'AirPlayGroups');
  private readonly outputs = new Map<number, AirplayGroupParticipant>();

  public register(zoneId: number, output: AirplayGroupParticipant): void {
    this.outputs.set(zoneId, output);
  }

  public unregister(zoneId: number): void {
    this.outputs.delete(zoneId);
  }

  /**
   * If the given output is a non-leader of an active group, attach its sender to
   * the leader's shared stream instead of starting a local engine session.
   * Returns true when local playback should be skipped.
   */
  public async tryJoinLeader(output: AirplayGroupParticipant): Promise<boolean> {
    const group = getGroupByZone(output.getZoneId());
    if (!group || group.leader === output.getZoneId()) {
      return false;
    }
    const leader = this.outputs.get(group.leader);
    if (!leader) {
      return false;
    }
    if (output.isAttachedToLeader(group.leader) && output.isRunning()) {
      return true;
    }
    output.markAttachedToLeader(group.leader);
    if (leader.isRunning()) {
      await this.attachMemberToLeader(leader, output);
    }
    return true; // always skip local playback for non-leaders
  }

  /** After the leader starts, attach every grouped member to its shared stream. */
  public async syncGroupMembers(leader: AirplayGroupParticipant): Promise<void> {
    const group = getGroupByZone(leader.getZoneId());
    if (!group || group.members.length === 0) {
      return;
    }
    for (const memberId of new Set([group.leader, ...group.members])) {
      if (memberId === leader.getZoneId()) {
        continue;
      }
      const member = this.outputs.get(memberId);
      if (!member) continue;
      if (member.isAttachedToLeader(leader.getZoneId()) && member.isRunning()) {
        continue;
      }
      await this.attachMemberToLeader(leader, member);
      member.markAttachedToLeader(leader.getZoneId());
    }
  }

  public onLeaderStopped(leaderZoneId: number): void {
    for (const output of this.outputs.values()) {
      if (output.isAttachedToLeader(leaderZoneId)) {
        output.clearLeaderAttachment();
      }
    }
  }

  public async stopGroupMembers(leaderZoneId: number, members: number[]): Promise<void> {
    const memberIds = new Set<number>(members);
    memberIds.delete(leaderZoneId);
    for (const memberId of memberIds) {
      const member = this.outputs.get(memberId);
      if (!member) {
        continue;
      }
      this.log.debug('stop airplay group member', { leader: leaderZoneId, member: memberId });
      try {
        await member.stopLocal();
      } catch {
        /* ignore */
      } finally {
        member.clearLeaderAttachment();
      }
    }
  }

  /** Detach a member from its current leader, tearing down its sender. */
  public async detachMember(member: AirplayGroupParticipant): Promise<void> {
    const leaderId = member.getAttachedLeaderId();
    member.clearLeaderAttachment();
    try {
      await member.stopLocal();
    } catch {
      /* ignore */
    }
    if (leaderId !== null) {
      this.log.debug('detached airplay member from leader', {
        leader: leaderId,
        member: member.getZoneId(),
      });
    }
  }

  /**
   * When a group is created/updated while the leader is already playing, attach
   * all members to the running leader.
   */
  public async syncCurrentGroup(leaderZoneId: number): Promise<void> {
    const leader = this.outputs.get(leaderZoneId);
    if (!leader || !leader.isRunning()) {
      return;
    }
    await this.syncGroupMembers(leader);
  }

  private async attachMemberToLeader(
    leader: AirplayGroupParticipant,
    member: AirplayGroupParticipant,
  ): Promise<void> {
    const stream = leader.getSharedStream();
    if (!stream) {
      this.log.warn('airplay group: leader has no shared stream', {
        leader: leader.getZoneId(),
        member: member.getZoneId(),
      });
      return;
    }
    this.log.debug('attach airplay member to leader stream', {
      leader: leader.getZoneId(),
      member: member.getZoneId(),
    });
    await member.startFromLeaderStream(stream, member.getCurrentVolume());
  }
}

export function createAirplayGroupController(_audioManager: AudioManager): AirplayGroupCoordinator {
  return new AirplayGroupController();
}
