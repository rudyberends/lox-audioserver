import { createLogger } from '@/shared/logging/logger';
import { getGroupByZone } from '@/application/groups/groupTracker';
import type { SlimClient } from '@lox-audioserver/node-slimproto';
import { PlayerState } from '@lox-audioserver/node-slimproto';

export type SqueezeliteGroupParticipant = {
  zoneId: number;
  getPlayer: () => SlimClient | null;
  getLatencyMs: () => number;
};

export type SqueezeliteGroupCoordinator = {
  register: (participant: SqueezeliteGroupParticipant) => void;
  unregister: (zoneId: number) => void;
  preparePlayback: (zoneId: number) => {
    grouped: boolean;
    leaderZoneId: number;
    expectedCount: number;
  };
  /**
   * Start/replace playback for a sync-group by issuing playUrl to all active members.
   * This is required because only the leader zone gets a new session on track switches.
   */
  orchestrateGroupPlayback: (
    leaderZoneId: number,
    url: string,
    mimeType: string,
    metadata: Record<string, string | number>,
  ) => Promise<boolean>;
  orchestrateGroupPause: (zoneId: number) => Promise<boolean>;
  orchestrateGroupResume: (zoneId: number) => Promise<boolean>;
  orchestrateGroupStop: (zoneId: number) => Promise<boolean>;
  notifyBufferReady: (zoneId: number) => void;
  notifyPlaybackTick: (zoneId: number) => void;
  /** True while a resync pause-and-unpause is in flight for the given zone. */
  isZoneResyncing: (zoneId: number) => boolean;
};

type PendingGroup = {
  expectedZones: Set<number>;
  startedAt: number;
  timeoutId: NodeJS.Timeout;
  pollId?: NodeJS.Timeout;
};

type SyncPlaypoint = { ts: number; diffMs: number };

class SqueezeliteGroupController {
  private readonly log = createLogger('Output', 'SqueezeliteGroups');
  private readonly participants = new Map<number, SqueezeliteGroupParticipant>();
  private readonly pendingGroups = new Map<number, PendingGroup>();
  // Match Music Assistant multi-client stream + buffer ready polling (5s-ish).
  private readonly readyTimeoutMs = 5000;
  private readonly readyPollIntervalMs = 200;
  // Base headroom before scheduled unpause. We will increase this dynamically based on clock RTT.
  private readonly unpauseHeadroomMs = 200;
  private readonly syncPlaypoints = new Map<string, SyncPlaypoint[]>();
  private readonly doNotResyncBefore = new Map<string, number>();
  private readonly lastTickAt = new Map<string, number>();
  private readonly resyncingZones = new Set<number>();
  private readonly minReqPlaypoints = 8;
  private readonly minDeviationAdjustMs = 8;
  private readonly deviationJumpIgnoreMs = 500;
  private readonly maxSkipAheadMs = 800;

  constructor() {}

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

    const existing = this.pendingGroups.get(leaderZoneId);
    if (existing) {
      existing.expectedZones = activeZones;
    } else {
      this.pendingGroups.set(leaderZoneId, {
        expectedZones: activeZones,
        startedAt: Date.now(),
        timeoutId: setTimeout(() => {
          const pending = this.pendingGroups.get(leaderZoneId);
          if (!pending) return;
          void (async () => {
            const started = await this.startGroup(leaderZoneId, pending.expectedZones);
            if (started) {
              this.pendingGroups.delete(leaderZoneId);
              return;
            }
            // Nothing was ready yet; extend the window and keep polling.
            pending.startedAt = Date.now();
            pending.timeoutId = setTimeout(() => {
              const again = this.pendingGroups.get(leaderZoneId);
              if (!again) return;
              void this.startGroup(leaderZoneId, again.expectedZones).then((ok) => {
                if (ok) this.pendingGroups.delete(leaderZoneId);
              });
            }, this.readyTimeoutMs);
            pending.timeoutId.unref?.();
            this.schedulePendingCheck(leaderZoneId);
          })();
        }, this.readyTimeoutMs),
      });
      // Start polling immediately so we don't depend on events.
      this.schedulePendingCheck(leaderZoneId);
    }
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
    this.schedulePendingCheck(leaderZoneId);
  }

  private schedulePendingCheck(leaderZoneId: number): void {
    const pending = this.pendingGroups.get(leaderZoneId);
    if (!pending) return;
    if (pending.pollId) return;
    pending.pollId = setTimeout(() => {
      pending.pollId = undefined;
      void this.checkPendingGroupReady(leaderZoneId);
    }, 0);
    pending.pollId.unref?.();
  }

  private async checkPendingGroupReady(leaderZoneId: number): Promise<void> {
    const pending = this.pendingGroups.get(leaderZoneId);
    if (!pending) return;
    const now = Date.now();
    if (now - pending.startedAt > this.readyTimeoutMs) {
      // Timeout handler will start the group; just stop polling.
      return;
    }

    let total = 0;
    let ready = 0;
    for (const zoneId of pending.expectedZones) {
      const player = this.participants.get(zoneId)?.getPlayer();
      if (!player) continue;
      total += 1;
      if (player.state === PlayerState.BUFFER_READY) {
        ready += 1;
      }
    }
    if (total >= 2 && ready >= total) {
      clearTimeout(pending.timeoutId);
      if (pending.pollId) {
        clearTimeout(pending.pollId);
        pending.pollId = undefined;
      }
      this.pendingGroups.delete(leaderZoneId);
      await this.startGroup(leaderZoneId, pending.expectedZones);
      return;
    }

    pending.pollId = setTimeout(() => {
      pending.pollId = undefined;
      void this.checkPendingGroupReady(leaderZoneId);
    }, this.readyPollIntervalMs);
    pending.pollId.unref?.();
  }

  private getActiveGroupPlayersFor(zoneId: number): Array<{ zoneId: number; player: SlimClient }> {
    const group = getGroupByZone(zoneId);
    if (!group || group.members.length < 2) {
      return [];
    }
    const expectedZones = new Set<number>([group.leader, ...group.members]);
    const entries: Array<{ zoneId: number; player: SlimClient }> = [];
    for (const memberId of expectedZones) {
      const participant = this.participants.get(memberId);
      const player = participant?.getPlayer();
      if (player) {
        entries.push({ zoneId: memberId, player });
      }
    }
    return entries;
  }

  public async orchestrateGroupPlayback(
    leaderZoneId: number,
    url: string,
    mimeType: string,
    metadata: Record<string, string | number>,
  ): Promise<boolean> {
    const entries = this.getActiveGroupPlayersFor(leaderZoneId);
    if (entries.length < 2) {
      return false;
    }

    // Ensure pending group tracking exists before BUFFER_READY events arrive.
    this.preparePlayback(leaderZoneId);

    // Equivalent to MA/aioslimproto behavior: issue play_url to all clients (autostart=0),
    // let them buffer until BUFFER_READY; unpause is coordinated by the controller.
    await Promise.all(
      entries.map(async ({ player }) => {
        try {
          await player.playUrl(url, mimeType, metadata, undefined, 0, false, false, true);
        } catch {
          // ignore per-client failures; group will degrade to fewer members
        }
      }),
    );
    // Kick a poll in case BUFFER_READY events are missed/racy.
    this.schedulePendingCheck(leaderZoneId);
    return true;
  }

  public async orchestrateGroupPause(zoneId: number): Promise<boolean> {
    const entries = this.getActiveGroupPlayersFor(zoneId);
    if (entries.length < 2) return false;
    await Promise.all(entries.map(async ({ player }) => player.pause().catch(() => undefined)));
    return true;
  }

  public async orchestrateGroupStop(zoneId: number): Promise<boolean> {
    const group = getGroupByZone(zoneId);
    const leaderZoneId = group?.leader ?? zoneId;
    const entries = this.getActiveGroupPlayersFor(zoneId);
    if (entries.length < 2) return false;
    const pending = this.pendingGroups.get(leaderZoneId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      if (pending.pollId) {
        clearTimeout(pending.pollId);
      }
      this.pendingGroups.delete(leaderZoneId);
    }
    await Promise.all(entries.map(async ({ player }) => player.stop().catch(() => undefined)));
    return true;
  }

  public async orchestrateGroupResume(zoneId: number): Promise<boolean> {
    const entries = this.getActiveGroupPlayersFor(zoneId);
    if (entries.length < 2) return false;

    // Sync clocks first so we can resume in lock-step using a shared server timestamp.
    await Promise.all(entries.map((entry) => entry.player.requestClockSync().catch(() => false)));

    const enriched = entries.map((entry) => ({
      ...entry,
      latencyMs: this.participants.get(entry.zoneId)?.getLatencyMs?.() ?? 0,
    }));
    const maxLatencyMs = enriched.reduce((max, entry) => Math.max(max, entry.latencyMs), 0);
    const maxRttMs = enriched.reduce((max, entry) => Math.max(max, entry.player.clockSync?.rttMs ?? 0), 0);
    const headroom = Math.max(this.unpauseHeadroomMs, Math.min(1500, 300 + Math.round(maxRttMs)));
    const audibleAtMs = Date.now() + headroom + Math.max(0, maxLatencyMs);
    for (const entry of enriched) {
      const startAtMs = audibleAtMs - entry.latencyMs;
      const target = entry.player.estimateJiffiesAt(startAtMs);
      void entry.player.unpauseAt(target);
    }
    return true;
  }

  public notifyPlaybackTick(zoneId: number): void {
    const group = getGroupByZone(zoneId);
    if (!group || group.members.length < 2) {
      return;
    }
    const leaderZoneId = group.leader;
    const leader = this.participants.get(leaderZoneId)?.getPlayer();
    const leaderLatency = this.participants.get(leaderZoneId)?.getLatencyMs?.() ?? 0;
    if (!leader || leader.state !== PlayerState.PLAYING) {
      return;
    }

    const memberIds = new Set<number>([leaderZoneId, ...group.members]);
    for (const memberId of memberIds) {
      if (memberId === leaderZoneId) continue;
      const member = this.participants.get(memberId)?.getPlayer();
      const memberLatency = this.participants.get(memberId)?.getLatencyMs?.() ?? 0;
      if (!member || member.state !== PlayerState.PLAYING) continue;

      const key = `${leaderZoneId}:${memberId}`;
      const now = Date.now();
      const lastTick = this.lastTickAt.get(key) ?? 0;
      if (now - lastTick < 500) {
        continue;
      }
      this.lastTickAt.set(key, now);

      const leaderElapsed = (leader.elapsedMilliseconds ?? 0) - leaderLatency;
      const memberElapsed = (member.elapsedMilliseconds ?? 0) - memberLatency;
      if (!Number.isFinite(leaderElapsed) || !Number.isFinite(memberElapsed)) {
        continue;
      }
      const diff = Math.round(leaderElapsed - memberElapsed);
      this.log.spam('squeezelite group sync tick', {
        leaderZoneId,
        memberId,
        leaderElapsedMs: Math.round(leaderElapsed),
        memberElapsedMs: Math.round(memberElapsed),
        diffMs: diff,
      });

      const points = this.syncPlaypoints.get(key) ?? [];
      if (points.length > 0 && now - points[points.length - 1]!.ts > 10_000) {
        points.length = 0;
      }
      points.push({ ts: now, diffMs: diff });
      if (points.length > this.minReqPlaypoints) {
        points.splice(0, points.length - this.minReqPlaypoints);
      }
      this.syncPlaypoints.set(key, points);

      const blockUntil = this.doNotResyncBefore.get(key) ?? 0;
      if (now < blockUntil) {
        continue;
      }

      const req = leader.elapsedMilliseconds < 2000 ? 2 : this.minReqPlaypoints;
      if (points.length < req) {
        continue;
      }

      const diffsAbs = points.map((p) => Math.abs(p.diffMs));
      const avgAbs = diffsAbs.reduce((a, b) => a + b, 0) / diffsAbs.length;
      if (Math.abs(avgAbs - Math.abs(diff)) > this.deviationJumpIgnoreMs) {
        continue;
      }
      const avg = points.map((p) => p.diffMs).reduce((a, b) => a + b, 0) / points.length;
      const delta = Math.round(Math.abs(avg));
      if (delta < this.minDeviationAdjustMs) {
        continue;
      }

      // Apply correction and debounce. Similar strategy as Music Assistant's squeezelite provider.
      this.syncPlaypoints.set(key, []);
      this.doNotResyncBefore.set(key, now + 5000);

      if (avg > this.maxSkipAheadMs) {
        // member lags badly; slow down the leader a bit.
        void this.pauseAndUnpause(leaderZoneId, leader, delta);
        this.log.debug('squeezelite group resync (pause leader)', {
          leaderZoneId,
          memberId,
          deltaMs: delta,
        });
      } else if (avg > 0) {
        // member is behind; skip ahead a little.
        void member.skipOver(delta);
        this.log.debug('squeezelite group resync (skip member)', {
          leaderZoneId,
          memberId,
          deltaMs: delta,
        });
      } else {
        // member is ahead; pause briefly.
        void this.pauseAndUnpause(memberId, member, delta);
        this.log.debug('squeezelite group resync (pause member)', {
          leaderZoneId,
          memberId,
          deltaMs: delta,
        });
      }
    }
  }

  private async pauseAndUnpause(zoneId: number, player: SlimClient, pauseDurationMs: number): Promise<void> {
    this.resyncingZones.add(zoneId);
    try {
      try {
        await player.pause();
      } catch {
        // ignore
      }
      const ts = (player.jiffies || 0) + Math.max(0, Math.round(pauseDurationMs));
      await player.unpauseAt(ts);
    } finally {
      // Keep the resyncing flag active until the player has had time to actually resume.
      // unpauseAt() returns as soon as the command is sent, but the player may still be
      // paused (waiting for its jiffies target). Any 'paused' STAT arriving before the
      // player resumes must be suppressed, otherwise the zone power manager sees a
      // pause→stop transition and kills the group member.
      const clearDelay = Math.max(200, Math.round(pauseDurationMs) + 150);
      setTimeout(() => this.resyncingZones.delete(zoneId), clearDelay).unref?.();
    }
  }

  public isZoneResyncing(zoneId: number): boolean {
    return this.resyncingZones.has(zoneId);
  }

  private async startGroup(
    leaderZoneId: number,
    zones: Set<number>,
  ): Promise<boolean> {
    const entries: Array<{ zoneId: number; player: SlimClient; latencyMs: number }> = [];
    for (const zoneId of zones) {
      const participant = this.participants.get(zoneId);
      const player = participant?.getPlayer();
      if (player) {
        // Always require BUFFER_READY for a coordinated start.
        // On timeout fallback we simply start a smaller subset if needed.
        if (player.state !== PlayerState.BUFFER_READY) continue;
        const latencyMs = participant?.getLatencyMs?.() ?? 0;
        entries.push({
          zoneId,
          player,
          latencyMs: Number.isFinite(latencyMs) ? Math.round(latencyMs) : 0,
        });
      }
    }
    if (entries.length < 2) return false;

    // Sync clocks first so we can schedule everyone against a shared server time.
    await Promise.all(entries.map((entry) => entry.player.requestClockSync().catch(() => false)));

    const maxRttMs = entries.reduce((max, entry) => Math.max(max, entry.player.clockSync?.rttMs ?? 0), 0);
    const headroom = Math.max(this.unpauseHeadroomMs, Math.min(1500, 300 + Math.round(maxRttMs)));
    const maxLatencyMs = entries.reduce((max, entry) => Math.max(max, entry.latencyMs), 0);
    const audibleAtMs = Date.now() + headroom + Math.max(0, maxLatencyMs);
    for (const entry of entries) {
      const startAtMs = audibleAtMs - entry.latencyMs;
      const target = entry.player.estimateJiffiesAt(startAtMs);
      const cs = entry.player.clockSync;
      this.log.debug('squeezelite group start unpauseAt', {
        zoneId: entry.zoneId,
        target,
        startAtMs,
        clockBaseJiffies: cs?.jiffies ?? null,
        clockBaseServerTimeMs: cs?.serverTimeMs ?? null,
        clockBaseRttMs: cs?.rttMs ?? null,
        clockBaseAgeMs: cs ? Math.round(Date.now() - cs.serverTimeMs) : null,
        playerJiffies: entry.player.jiffies ?? null,
      });
      void entry.player.unpauseAt(target);
    }
    this.log.debug('squeezelite group start', {
      leaderZoneId,
      headroomMs: headroom,
      audibleAtMs,
      members: entries.map((entry) => entry.zoneId),
      latencyMs: Object.fromEntries(entries.map((entry) => [entry.zoneId, entry.latencyMs])),
    });
    return true;
  }
}

export function createSqueezeliteGroupController(): SqueezeliteGroupCoordinator {
  return new SqueezeliteGroupController();
}
