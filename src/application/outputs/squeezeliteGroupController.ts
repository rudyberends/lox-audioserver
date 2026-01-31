import { createLogger } from '@/shared/logging/logger';
import { getGroupByZone, onGroupChanged } from '@/application/groups/groupTracker';
import type { SlimClient } from '@lox-audioserver/node-slimproto';

export type SqueezeliteGroupParticipant = {
  zoneId: number;
  getPlayer: () => SlimClient | null;
};

export type SqueezeliteGroupCoordinator = {
  register: (participant: SqueezeliteGroupParticipant) => void;
  unregister: (zoneId: number) => void;
  preparePlayback: (zoneId: number) => {
    grouped: boolean;
    leaderZoneId: number;
    expectedCount: number;
  };
  notifyBufferReady: (zoneId: number) => void;
};

type PendingGroup = {
  expectedZones: Set<number>;
  readyZones: Set<number>;
  startedAt: number;
  timeoutId: NodeJS.Timeout;
};

class SqueezeliteGroupController {
  private readonly log = createLogger('Output', 'SqueezeliteGroups');
  private readonly participants = new Map<number, SqueezeliteGroupParticipant>();
  private readonly pendingGroups = new Map<number, PendingGroup>();
  private readonly readyTimeoutMs = 10000;
  private readonly unpauseHeadroomMs = 200;

  constructor() {
    onGroupChanged((_event, leader) => {
      if (leader != null) {
        const pending = this.pendingGroups.get(leader);
        if (pending) {
          clearTimeout(pending.timeoutId);
          this.pendingGroups.delete(leader);
        }
      }
    });
  }

  public register(participant: SqueezeliteGroupParticipant): void {
    this.participants.set(participant.zoneId, participant);
  }

  public unregister(zoneId: number): void {
    this.participants.delete(zoneId);
  }

  public preparePlayback(
    zoneId: number,
  ): { grouped: boolean; leaderZoneId: number; expectedCount: number } {
    const group = getGroupByZone(zoneId);
    if (!group || group.members.length === 0) {
      return { grouped: false, leaderZoneId: zoneId, expectedCount: 1 };
    }
    const leaderZoneId = group.leader;
    const expectedZones = new Set<number>([leaderZoneId, ...group.members]);
    const readyZones = new Set<number>();
    const activeZones = new Set<number>();
    for (const memberId of expectedZones) {
      const participant = this.participants.get(memberId);
      const player = participant?.getPlayer();
      if (player) {
        activeZones.add(memberId);
      }
    }
    if (activeZones.size < 2) {
      return { grouped: false, leaderZoneId: zoneId, expectedCount: 1 };
    }
    this.pendingGroups.set(leaderZoneId, {
      expectedZones: activeZones,
      readyZones,
      startedAt: Date.now(),
      timeoutId: setTimeout(() => {
        const pending = this.pendingGroups.get(leaderZoneId);
        if (!pending) return;
        this.startGroup(leaderZoneId, pending.expectedZones);
        this.pendingGroups.delete(leaderZoneId);
      }, this.readyTimeoutMs),
    });
    return {
      grouped: true,
      leaderZoneId,
      expectedCount: activeZones.size,
    };
  }

  public notifyBufferReady(zoneId: number): void {
    const group = getGroupByZone(zoneId);
    if (!group) return;
    const leaderZoneId = group.leader;
    const pending = this.pendingGroups.get(leaderZoneId);
    if (!pending) return;
    if (Date.now() - pending.startedAt > this.readyTimeoutMs) {
      clearTimeout(pending.timeoutId);
      this.pendingGroups.delete(leaderZoneId);
      return;
    }
    pending.readyZones.add(zoneId);
    if (pending.readyZones.size < pending.expectedZones.size) {
      return;
    }
    clearTimeout(pending.timeoutId);
    this.startGroup(leaderZoneId, pending.expectedZones);
    this.pendingGroups.delete(leaderZoneId);
  }

  private startGroup(leaderZoneId: number, zones: Set<number>): void {
    const entries: Array<{ zoneId: number; player: SlimClient }> = [];
    for (const zoneId of zones) {
      const participant = this.participants.get(zoneId);
      const player = participant?.getPlayer();
      if (player) {
        entries.push({ zoneId, player });
      }
    }
    if (entries.length < 2) return;
    const leaderEntry =
      entries.find((entry) => entry.zoneId === leaderZoneId) ?? entries[0];
    const baseJiffies = leaderEntry.player.jiffies || 0;
    const targetJiffies = baseJiffies + this.unpauseHeadroomMs;
    for (const entry of entries) {
      void entry.player.unpauseAt(targetJiffies);
    }
    this.log.debug('squeezelite group start', {
      leaderZoneId,
      targetJiffies,
      members: entries.map((entry) => entry.zoneId),
    });
  }
}

export function createSqueezeliteGroupController(): SqueezeliteGroupCoordinator {
  return new SqueezeliteGroupController();
}
