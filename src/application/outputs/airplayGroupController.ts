import { getGroupByZone } from '@/application/groups/groupTracker';
import { createLogger } from '@/shared/logging/logger';
import { unixMsToNtp } from '@/shared/airplayNtp';
import type { AudioManager } from '@/application/playback/audioManager';

export type AirplaySenderLike = {
  isRunning(): boolean;
};

export type AirplayGroupParticipant = {
  getZoneId(): number;
  getClientId(): string;
  getCurrentVolume(): number;
  getSender(): AirplaySenderLike;
  getStreamForClients(): NodeJS.ReadableStream | null;
  getLastInputUrl(): string | null;
  getSecondsStreamed(): number;
  isRunning(): boolean;
  addMultiroomClient: (
    clientId: string,
    sender: AirplaySenderLike,
    volume: number,
    inputUrl?: string | null,
    stream?: NodeJS.ReadableStream | null,
    ntpStart?: bigint,
    primeBacklog?: boolean,
  ) => Promise<void>;
  markAttachedToLeader(leaderId: number): void;
  clearLeaderAttachment(): void;
  isAttachedToLeader(leaderId: number): boolean;
  getAttachedLeaderId(): number | null;
  stopClient(clientId: string): Promise<void>;
  stop(session: unknown | null): Promise<void>;
};

export type AirplayGroupCoordinator = {
  register: (zoneId: number, output: AirplayGroupParticipant) => void;
  unregister: (zoneId: number) => void;
  getBaseStartOffsetMs: () => number;
  ensureStartNtp: (leaderZoneId: number) => bigint;
  tryJoinLeader: (output: AirplayGroupParticipant) => Promise<boolean>;
  syncGroupMembers: (
    leader: AirplayGroupParticipant,
    inputUrl: string | null,
    stream: NodeJS.ReadableStream | null,
    ntpStart?: bigint,
  ) => Promise<void>;
  stopGroupMembers: (leaderZoneId: number, members: number[]) => Promise<void>;
  detachMember: (member: AirplayGroupParticipant) => Promise<void>;
  syncCurrentGroup: (leaderZoneId: number) => Promise<void>;
  onLeaderStopped: (leaderZoneId: number) => void;
};

/**
 * Orchestrates AirPlay multiroom by reusing the leader's FlowSession to
 * stream to all grouped AirPlay targets. Non-leader outputs skip their own
 * playback and join the leader's session.
 */
class AirplayGroupController {
  private readonly log = createLogger('Output', 'AirPlayGroups');
  private readonly outputs = new Map<number, AirplayGroupParticipant>();
  private readonly startNtpByLeader = new Map<number, bigint>();
  private readonly leaderStartMs = new Map<number, number>();
  private readonly baseStartOffsetMs = 2000 + 1200 + 150; // connect + output buffer + process spawn
  private readonly perClientOffsetMs = 150; // extra per client to allow setup
  private readonly memberStartOffsetMs = 400; // shorter lead time for mid-stream joins

  constructor(private readonly audioManager: AudioManager) {}

  public register(zoneId: number, output: AirplayGroupParticipant): void {
    this.outputs.set(zoneId, output);
  }

  public unregister(zoneId: number): void {
    this.outputs.delete(zoneId);
    this.startNtpByLeader.delete(zoneId);
    this.leaderStartMs.delete(zoneId);
  }

  public getBaseStartOffsetMs(): number {
    return this.baseStartOffsetMs;
  }

  /**
   * If the given output is not the group leader but its leader is active,
   * attach to the leader's multiroom session instead of playing locally.
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
    if (output.isAttachedToLeader(group.leader) && output.getSender().isRunning()) {
      return true;
    }
    output.markAttachedToLeader(group.leader);
    if (leader && leader.isRunning()) {
      const leaderSeconds = this.getLeaderSeconds(group.leader);
      const primeBacklog = leaderSeconds < 0.5; // only prime if leader just started
      const startForMember = primeBacklog
        ? unixMsToNtp(Date.now() + this.memberStartOffsetMs)
        : undefined;
      const leaderStream = leader.getStreamForClients();
      const leaderUrl = leader.getLastInputUrl();
      await this.attachClientToLeader(
        leader,
        output,
        leaderUrl,
        leaderStream,
        startForMember,
        primeBacklog,
      );
    }
    return true; // always skip local playback for non-leaders
  }

  /**
   * After the leader starts playback, attach all grouped members that have an AirPlay output.
   */
  public async syncGroupMembers(
    leader: AirplayGroupParticipant,
    inputUrl: string | null,
    stream: NodeJS.ReadableStream | null,
    ntpStart?: bigint,
  ): Promise<void> {
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
      if (member.isAttachedToLeader(leader.getZoneId()) && member.getSender().isRunning()) {
        this.log.debug('airplay group member already attached', {
          leader: leader.getZoneId(),
          member: memberId,
          clientId: member.getClientId(),
        });
        continue;
      }
      const leaderSeconds = this.getLeaderSeconds(leader.getZoneId());
      const primeBacklog = leaderSeconds < 0.5;
      const startForMember = primeBacklog
        ? ntpStart ?? unixMsToNtp(Date.now() + this.memberStartOffsetMs)
        : undefined;
      await this.attachClientToLeader(
        leader,
        member,
        inputUrl,
        stream ?? leader.getStreamForClients(),
        startForMember,
        primeBacklog,
      );
      member.markAttachedToLeader(group.leader);
    }
  }

  public onLeaderStopped(leaderZoneId: number): void {
    for (const output of this.outputs.values()) {
      if (output.isAttachedToLeader(leaderZoneId)) {
        output.clearLeaderAttachment();
      }
    }
    this.startNtpByLeader.delete(leaderZoneId);
    this.leaderStartMs.delete(leaderZoneId);
  }

  public async stopGroupMembers(leaderZoneId: number, members: number[]): Promise<void> {
    const memberIds = new Set<number>(members);
    memberIds.delete(leaderZoneId);

    for (const memberId of memberIds) {
      const member = this.outputs.get(memberId);
      if (!member) {
        continue;
      }
      this.log.debug('stop airplay group member', {
        leader: leaderZoneId,
        member: memberId,
        clientId: member.getClientId(),
        attachedLeader: member.getAttachedLeaderId(),
      });
      try {
        await member.stop(null);
      } catch {
        /* ignore */
      } finally {
        member.clearLeaderAttachment();
      }
    }
  }

  /**
   * Detach a member from its current leader's flow session.
   */
  public async detachMember(member: AirplayGroupParticipant): Promise<void> {
    const leaderId = member.getAttachedLeaderId();
    if (!leaderId) {
      return;
    }
    const leader = this.outputs.get(leaderId);
    if (!leader) {
      member.clearLeaderAttachment();
      return;
    }
    const clientId = member.getClientId();
    this.log.debug('detach airplay client from leader session', {
      leader: leaderId,
      member: member.getZoneId(),
      clientId,
    });
    await leader.stopClient(clientId);
    member.clearLeaderAttachment();
  }

  /**
   * When a group is created/updated while the leader is already playing,
   * attach all members to the running leader session.
   */
  public async syncCurrentGroup(leaderZoneId: number): Promise<void> {
    const leader = this.outputs.get(leaderZoneId);
    if (!leader || !leader.isRunning()) {
      return;
    }
    const inputUrl = leader.getLastInputUrl();
    const stream = leader.getStreamForClients();
    await this.syncGroupMembers(leader, inputUrl, stream, undefined);
  }

  private async attachClientToLeader(
    leader: AirplayGroupParticipant,
    member: AirplayGroupParticipant,
    inputUrl?: string | null,
    stream?: NodeJS.ReadableStream | null,
    ntpStart?: bigint,
    primeBacklog = true,
  ): Promise<void> {
    const sender = member.getSender();
    const clientId = member.getClientId();
    const volume = member.getCurrentVolume();
    this.log.debug('attach airplay client to leader session', {
      leader: leader.getZoneId(),
      member: member.getZoneId(),
      clientId,
      inputUrl: inputUrl ?? leader.getLastInputUrl(),
    });
    await leader.addMultiroomClient(
      clientId,
      sender,
      volume,
      inputUrl,
      stream,
      ntpStart,
      primeBacklog,
    );
  }

  public ensureStartNtp(leaderZoneId: number): bigint {
    const now = Date.now();
    const existingNtp = this.startNtpByLeader.get(leaderZoneId);
    const existingMs = this.leaderStartMs.get(leaderZoneId) ?? 0;
    const minStart = now + this.computeStartOffsetMs(leaderZoneId);

    if (existingNtp && existingMs >= minStart) {
      return existingNtp;
    }

    const startMs = minStart;
    const ntp = unixMsToNtp(startMs);
    this.startNtpByLeader.set(leaderZoneId, ntp);
    this.leaderStartMs.set(leaderZoneId, startMs);
    this.log.debug('airplay ntpstart set/refreshed for leader', {
      leaderZoneId,
      startMs,
      ntpStart: ntp.toString(),
    });
    return ntp;
  }

  private computeStartOffsetMs(leaderZoneId: number): number {
    const group = getGroupByZone(leaderZoneId);
    const memberCount = group ? group.members.length + 1 : 1;
    return this.baseStartOffsetMs + this.perClientOffsetMs * memberCount;
  }

  private getElapsedSeconds(leaderZoneId: number): number {
    const startMs = this.leaderStartMs.get(leaderZoneId);
    if (!startMs) return 0;
    return Math.max(0, (Date.now() - startMs) / 1000);
  }

  private getLeaderSeconds(leaderZoneId: number): number {
    const session = this.audioManager.getSession(leaderZoneId);
    if (session && Number.isFinite(session.elapsed) && session.elapsed > 0) {
      return Math.max(0, session.elapsed);
    }
    return this.outputs.get(leaderZoneId)?.getSecondsStreamed() ?? 0;
  }
}

export function createAirplayGroupController(audioManager: AudioManager): AirplayGroupCoordinator {
  return new AirplayGroupController(audioManager);
}
