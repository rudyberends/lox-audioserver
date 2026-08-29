import { getGroupByZone } from '@/application/groups/groupTracker';
import { createLogger } from '@/shared/logging/logger';
import type { AudioManager } from '@/application/playback/audioManager';

// How far in the future the shared playback anchor is set. Must exceed the time
// to connect every member (RTSP ANNOUNCE/SETUP/RECORD, run in parallel) so they
// are all anchored and buffered before the common start. ~2s is comfortable for
// a handful of devices on a LAN.
const GROUP_PREBUFFER_MS = 3000;

/**
 * A grouped AirPlay output. Every device is an independent
 * RAOP sender, so multiroom is "one shared PCM stream, N senders": the leader
 * owns the engine stream and each member feeds its own sender from it. (Members
 * start as close together as the event loop allows; sample-accurate sync would
 * share one anchor instant, which node-airplay now takes on start().)
 */
export type AirplayGroupParticipant = {
  getZoneId(): number;
  getCurrentVolume(): number;
  isRunning(): boolean;
  getSharedStream(): NodeJS.ReadableStream | null;
  startFromLeaderStream(stream: NodeJS.ReadableStream, volume: number): Promise<void>;
  /** Compute the shared NTP playback anchor (delegated to the RAOP adapter). */
  computeGroupAnchor(prebufferMs: number): bigint;
  /** Open an engine subscriber to the leader's zone (synchronous, for batched alignment). */
  createGroupSubscriber(leaderZoneId: number): boolean;
  /** Start this member's sender from its group subscriber, anchored to the shared NTP start.
   * reAnchor re-anchors an already-streaming sender (leader was solo / member joined);
   * false just re-attaches (track change, stays synced). */
  startGroupedSender(anchorNtp: bigint, reAnchor: boolean): Promise<boolean>;
  stopLocal(): Promise<void>;
  markAttachedToLeader(leaderId: number): void;
  clearLeaderAttachment(): void;
  isAttachedToLeader(leaderId: number): boolean;
  getAttachedLeaderId(): number | null;
};

export type AirplayGroupCoordinator = {
  register: (zoneId: number, output: AirplayGroupParticipant) => void;
  unregister: (zoneId: number) => void;
  startSyncedGroup: (leaderZoneId: number, reAnchor: boolean) => Promise<boolean>;
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
  // Membership signature of the currently-synced group per leader. Lets a
  // redundant re-sync (group 'update' events fire on volume/state changes during
  // playback) be a no-op instead of tearing the whole group down and back up.
  private readonly syncedSignature = new Map<number, string>();

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
    // Already part of the (synced) group — the leader drives our sender, so don't
    // start a competing one. Also closes the race where startSyncedGroup has
    // marked us attached but our sender hasn't finished starting yet.
    if (output.isAttachedToLeader(group.leader)) {
      return true;
    }
    output.markAttachedToLeader(group.leader);
    if (leader.isRunning()) {
      // Joined a group that is already playing: re-sync the whole group from a
      // fresh shared anchor (re-anchors the running leader via flush, connects the
      // new member). Brief gap, but everyone ends up frame-locked.
      await this.startSyncedGroup(group.leader, true);
    }
    return true; // always skip local playback for non-leaders
  }

  /**
   * Sample-accurate group start. Subscribes every participant (leader + members)
   * to the LEADER's zone session in one synchronous batch — so each gets an
   * identical rolling-buffer snapshot (same frame 0) — then starts every sender
   * anchored to a single shared NTP time. Identical frames + identical anchor =
   * frame-locked playback across devices. Returns false (caller falls back to a
   * solo start) when this output is not a leader with members, or the engine
   * stream is unavailable. Re-invoking on the leader's track change re-batches
   * fresh subscribers and re-attaches (senders stay connected), keeping sync.
   */
  public async startSyncedGroup(leaderZoneId: number, reAnchor: boolean): Promise<boolean> {
    const group = getGroupByZone(leaderZoneId);
    if (!group || group.leader !== leaderZoneId || group.members.length === 0) {
      return false;
    }
    const leader = this.outputs.get(leaderZoneId);
    if (!leader) {
      return false;
    }
    const ids = [...new Set([leaderZoneId, ...group.members])];
    const participants = ids
      .map((id) => this.outputs.get(id))
      .filter((o): o is AirplayGroupParticipant => Boolean(o));
    if (participants.length === 0) {
      return false;
    }
    const signature = [...ids].sort((a, b) => a - b).join(',');
    const allRunning =
      participants.length === ids.length && participants.every((p) => p.isRunning());
    if (reAnchor && allRunning && this.syncedSignature.get(leaderZoneId) === signature) {
      // Already synced with this exact membership and all senders running. This is
      // a redundant re-sync (group 'update' events fire on volume/state changes
      // mid-playback); tearing the group down + back up here would drop audio.
      this.log.debug('airplay synced group already established; skipping re-sync', {
        leader: leaderZoneId,
        members: ids,
      });
      return true;
    }
    // Synchronous batch: every subscriber is created in the same tick, so the
    // engine's rolling-buffer snapshot is identical across members (same frame 0).
    const ok = participants.map((p) => p.createGroupSubscriber(leaderZoneId));
    if (ok.some((x) => !x)) {
      // Engine stream momentarily unavailable (e.g. mid-handoff on a track change).
      // Do NOT tear the senders down — that would drop audio on a transient miss.
      // Leave them as-is; the next sync/track event re-batches.
      this.log.warn('airplay synced group: engine stream unavailable, leaving senders intact', {
        leader: leaderZoneId,
      });
      return false;
    }
    // Mark members attached before the async starts so a racing member play() is a no-op.
    for (const p of participants) {
      if (p.getZoneId() !== leaderZoneId) {
        p.markAttachedToLeader(leaderZoneId);
      }
    }
    const anchor = leader.computeGroupAnchor(GROUP_PREBUFFER_MS);
    const results = await Promise.all(participants.map((p) => p.startGroupedSender(anchor, reAnchor)));
    const started = results.some(Boolean);
    if (started) {
      this.syncedSignature.set(leaderZoneId, signature);
    }
    this.log.info('airplay synced group started', {
      leader: leaderZoneId,
      members: ids,
      started: results.filter(Boolean).length,
    });
    return started;
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
    this.syncedSignature.delete(leaderZoneId);
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
    // Group created/updated while the leader is already playing → re-sync the
    // whole group from a fresh shared anchor (frame-locked), rather than the
    // unsynced best-effort attach.
    await this.startSyncedGroup(leaderZoneId, true);
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
