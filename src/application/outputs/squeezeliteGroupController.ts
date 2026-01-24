import { createLogger } from '@/shared/logging/logger';
import { getAllGroups, getGroupByZone, onGroupChanged } from '@/application/groups/groupTracker';
import type { SlimClient } from '@lox-audioserver/node-slimproto';
import { PlayerState } from '@lox-audioserver/node-slimproto';

export type SqueezeliteGroupParticipant = {
  zoneId: number;
  getPlayer: () => SlimClient | null;
};

export type SqueezeliteGroupCoordinator = {
  register: (participant: SqueezeliteGroupParticipant) => void;
  unregister: (zoneId: number) => void;
  requestSync: (zoneId?: number) => void;
};

type ParticipantEntry = {
  zoneId: number;
  player: SlimClient;
};

class SqueezeliteGroupController {
  private readonly log = createLogger('Output', 'SqueezeliteGroups');
  private readonly participants = new Map<number, SqueezeliteGroupParticipant>();
  private readonly lastCorrectionAt = new Map<string, number>();
  private readonly syncIntervalMs = 500;
  private readonly driftToleranceMs = 20;
  private readonly correctionCooldownMs = 750;
  private readonly maxCorrectionMs = 350;
  private readonly largeDriftMs = 750;
  private readonly maxLargeCorrectionMs = 1200;
  private readonly staleHeartbeatMs = 2500;
  private pendingImmediate = false;

  constructor() {
    onGroupChanged(() => this.requestSync());
    setInterval(() => this.syncOnce(), this.syncIntervalMs);
  }

  public register(participant: SqueezeliteGroupParticipant): void {
    this.participants.set(participant.zoneId, participant);
  }

  public unregister(zoneId: number): void {
    this.participants.delete(zoneId);
  }

  public requestSync(zoneId?: number): void {
    if (this.pendingImmediate) return;
    this.pendingImmediate = true;
    setTimeout(() => {
      this.pendingImmediate = false;
      if (zoneId) {
        this.syncGroupByZone(zoneId);
      } else {
        this.syncOnce();
      }
    }, 50);
  }

  private syncOnce(): void {
    const groups = getAllGroups();
    if (!groups.length) return;
    groups.forEach((group) => {
      this.syncGroup(group.leader);
    });
  }

  private syncGroupByZone(zoneId: number): void {
    const group = getGroupByZone(zoneId);
    if (!group) return;
    this.syncGroup(group.leader);
  }

  private syncGroup(leaderZoneId: number): void {
    const entries = this.getGroupEntries(leaderZoneId);
    if (entries.length < 2) {
      return;
    }

    const leader = this.pickLeader(entries, leaderZoneId);
    if (!leader) return;
    const leaderElapsed = leader.player.elapsedMilliseconds;

    for (const entry of entries) {
      if (entry.zoneId === leader.zoneId) continue;
      const player = entry.player;
      if (player.state !== PlayerState.PLAYING) continue;
      const heartbeatAt = player.lastHeartbeatAt;
      if (heartbeatAt && Date.now() - heartbeatAt > this.staleHeartbeatMs) {
        continue;
      }
      const delta = player.elapsedMilliseconds - leaderElapsed;
      if (Math.abs(delta) <= this.driftToleranceMs) {
        continue;
      }
      const lastCorrected = this.lastCorrectionAt.get(player.playerId) ?? 0;
      if (Date.now() - lastCorrected < this.correctionCooldownMs) {
        continue;
      }
      const maxAdjust =
        Math.abs(delta) > this.largeDriftMs ? this.maxLargeCorrectionMs : this.maxCorrectionMs;
      const adjustment = Math.min(Math.abs(delta), maxAdjust);
      if (delta > 0) {
        void player.pauseFor(adjustment);
      } else {
        void player.skipOver(adjustment);
      }
      this.lastCorrectionAt.set(player.playerId, Date.now());
      this.log.debug('squeezelite sync adjustment', {
        leaderZoneId,
        memberZoneId: entry.zoneId,
        playerId: player.playerId,
        deltaMs: Math.round(delta),
        adjustmentMs: adjustment,
        direction: delta > 0 ? 'pause' : 'skip',
      });
    }
  }

  private getGroupEntries(leaderZoneId: number): ParticipantEntry[] {
    const group = getGroupByZone(leaderZoneId);
    if (!group) return [];
    const entries: ParticipantEntry[] = [];
    const members = new Set<number>([group.leader, ...group.members]);
    for (const zoneId of members) {
      const participant = this.participants.get(zoneId);
      if (!participant) continue;
      const player = participant.getPlayer();
      if (!player) continue;
      entries.push({ zoneId, player });
    }
    return entries;
  }

  private pickLeader(entries: ParticipantEntry[], leaderZoneId: number): ParticipantEntry | null {
    const leaderCandidate = entries.find((entry) => entry.zoneId === leaderZoneId);
    if (leaderCandidate && leaderCandidate.player.state === PlayerState.PLAYING) {
      return leaderCandidate;
    }
    const playing = entries.find((entry) => entry.player.state === PlayerState.PLAYING);
    if (playing) return playing;
    return null;
  }
}

export function createSqueezeliteGroupController(): SqueezeliteGroupCoordinator {
  return new SqueezeliteGroupController();
}
