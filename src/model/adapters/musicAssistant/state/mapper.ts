import logger from '@/utils/troxorLogger';
import type { ZoneState } from '@/runtime/zones/types/zoneStateTypes';
import { AudioPlaybackMode } from '@/core/loxone/types';
import { zoneStateStore } from '@/runtime/zones/zoneStateStore';
import { removeGroupByLeader, getCurrentGroups } from '@/runtime/groups/groupTracker';
import { MusicAssistantApi } from '../api';
import type { MusicAssistantConfig } from '../types/config';
import type { EventMessage } from '../api/types';
import { findZoneByMaPlayerId } from '../utils/findZoneByMaPlayerId';
import { mapPlayerToState, mapQueueToState } from '../mappers/stateMapper';
import { Player, PlayerQueue } from '../types/musicAssistantTypes';
import { normalizeMembers, updateGroupFromBackend } from '@/runtime/zones/utils/groupUtils';
import { StateMapper } from '@/core/interfaces/stateMapper';

/**
 * -----------------------------------------------------------------------------
 * MusicAssistantStateMapper
 * -----------------------------------------------------------------------------
 * Synchronizes the Music Assistant player's state to the Loxone ZoneRuntime.
 * Handles player updates, queue changes, and group membership synchronization.
 * -----------------------------------------------------------------------------
 */
export class MusicAssistantStateMapper implements StateMapper {
  public readonly type = 'musicassistant' as const;

  private readonly zoneId: number;
  private readonly zoneName: string;

  private readonly maPlayerId: string;
  private readonly api: MusicAssistantApi;

  private unsubscribe?: () => void;
  private updateHandler?: (patch: Partial<ZoneState>) => void;

  private activeQueueId = '';
  private activeGroupLeaderId = '';
  private groupDisbandTimeout?: NodeJS.Timeout;

  // Anti-spam / state management
  private hasDisbanded = false;
  private lastRefreshTs = 0;
  private static readonly DISBAND_REFRESH_COOLDOWN_MS = 15000; // 15s cooldown

  // Debounce queue updates
  private lastQueueUpdateTs = 0;
  private static readonly QUEUE_UPDATE_DEBOUNCE_MS = 500; // 0.5s debounce
  private static readonly DISBAND_DEBOUNCE_MS = 2500; // 2.5 seconds

  constructor(params: MusicAssistantConfig) {
    this.zoneId = params.zoneId;
    this.zoneName = params.zoneName;
    this.maPlayerId = params.maPlayerId;
    this.api = MusicAssistantApi.acquire(params.ip, params.port ?? 8095);
  }

  /* -------------------------------------------------------------------------- */
  /* Lifecycle                                                                  */
  /* -------------------------------------------------------------------------- */

  async initialize(): Promise<void> {
    await this.api.connect();

    try {
      const queues = await this.api.getAllQueues();
      const myQueue =
        queues.find((q: { queue_id: string }) => q.queue_id === this.maPlayerId) ??
        queues.find((q: { queue_id: string }) => q.queue_id === this.activeQueueId);

      if (myQueue && typeof myQueue.queue_id === 'string') {
        const items = await this.api.getQueueItems(myQueue.queue_id);
        if (Array.isArray(items) && items.length > 0) {
          (myQueue as { items: unknown[] }).items = items;
        }
        await this.updateFromQueue(myQueue);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[MusicAssistantStateMapper][${this.zoneName}] Initial queue fetch failed: ${msg}`);
    }

    this.unsubscribe = this.api.onEvent((evt: EventMessage) => this.handleEvent(evt));
    await this.api.refreshFullState();
    logger.info(`[MusicAssistantStateMapper][${this.zoneName}] StateMapper initialized for ${this.maPlayerId}`);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;

    if (this.groupDisbandTimeout) {
      clearTimeout(this.groupDisbandTimeout);
      this.groupDisbandTimeout = undefined;
    }

    this.api.release();
    logger.info(`[MusicAssistantStateMapper][${this.zoneName}] StateMapper disposed`);
  }

  onUpdate(handler: (update: Partial<ZoneState>) => void): void {
    this.updateHandler = handler;
  }

  /* -------------------------------------------------------------------------- */
  /* Event Routing                                                              */
  /* -------------------------------------------------------------------------- */

  private handleEvent(evt: EventMessage): void {
    const eventName = String(evt.event ?? '').toLowerCase();
    const objectId = this.normalizeId(evt.object_id);
    const myId = this.normalizeId(this.maPlayerId);
    const queueId = this.normalizeId(this.activeQueueId);
    const leaderId = this.normalizeId(this.activeGroupLeaderId);
    const relevantIds = new Set([myId, queueId, leaderId].filter(Boolean));

    if (relevantIds.size > 0) {
      if (objectId && !relevantIds.has(objectId)) {
        return;
      }
      if (!objectId && (eventName.startsWith('queue_') || eventName.startsWith('player_'))) {
        return;
      }
    }

    switch (eventName) {
      case 'queue_added':
      case 'queue_updated':
        void this.updateFromQueue(evt.data);
        break;
      case 'queue_time_updated': // latest MA betas dont seem to use this anymore???
        this.handleQueueTime(evt.data);
        break;
      case 'player_added':
      case 'player_updated': // Latest beta uses player_update for progression
        this.updateFromPlayer(evt.data);
        break;
      default:
        break;
    }
  }

  private handleQueueTime(data: unknown): void {
    const seconds = Number(data ?? 0);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return;
    }

    const update: Partial<ZoneState> = {
      time: seconds,
      position_ms: Math.round(seconds * 1000),
      ...(seconds === 0 ? { mode: AudioPlaybackMode.Pause } : {}),
    };
    this.pushPlayerStatusUpdate(update);
  }

  /* -------------------------------------------------------------------------- */
  /* Queue and Player Mapping                                                   */
  /* -------------------------------------------------------------------------- */

  private async updateFromQueue(queueData: PlayerQueue): Promise<void> {
    if (!queueData || typeof queueData.queue_id !== 'string') {
      return;
    }

    // Debounce: ignore multiple queue updates in a very short interval
    const now = Date.now();
    if (now - this.lastQueueUpdateTs < MusicAssistantStateMapper.QUEUE_UPDATE_DEBOUNCE_MS) {
      return;
    }
    this.lastQueueUpdateTs = now;

    try {
      const mapped = mapQueueToState(this.zoneId!, queueData);
      if (!mapped) {
        return;
      }

      this.activeQueueId = this.normalizeId(queueData.queue_id);

      zoneStateStore.patch(this.zoneId!, {
        ...mapped.trackUpdate,
        queue: mapped.queue,
      });

      logger.info(
        `[MusicAssistantStateMapper][${this.zoneName}] Queue updated (${mapped.queue!.totalitems} items, shuffle=${mapped.queue!.shuffle})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[MusicAssistantStateMapper][${this.zoneName}] updateFromQueue failed: ${msg}`);
    }
  }

  private updateFromPlayer(playerData: Player): void {
    try {
      const leaderId = this.normalizeId(playerData.synced_to);
      this.activeGroupLeaderId = leaderId;

      const patch = mapPlayerToState(this.zoneId!, playerData);
      this.pushPlayerStatusUpdate(patch);

      this.syncGroupMembership(playerData);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[MusicAssistantStateMapper][${this.zoneName}] updateFromPlayer failed: ${msg}`);
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Group Synchronization Logic                                                */
  /* -------------------------------------------------------------------------- */

  private async maybeRefreshFullState(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRefreshTs < MusicAssistantStateMapper.DISBAND_REFRESH_COOLDOWN_MS) {
      return; // Cooldown active, skip redundant refresh
    }
    await this.api.refreshFullState();
    this.lastRefreshTs = now;
    logger.debug(`[MusicAssistantStateMapper][${this.zoneName}] Full state refreshed after disband`);
  }

  private syncGroupMembership(playerData: Player): void {
    const backend = 'MusicAssistant' as const;
    const selfZone = findZoneByMaPlayerId(this.maPlayerId);
    if (!selfZone) {
      return;
    }

    const hasGroupField =
      'synced_to' in playerData ||
      'group_leader' in playerData ||
      'group_members' in playerData ||
      'group_childs' in playerData;
    if (!hasGroupField) {
      return;
    }

    const rawLeaderId = playerData.synced_to ?? null;
    const leaderId = this.normalizeId(rawLeaderId ?? this.maPlayerId);
    const leaderZone = rawLeaderId ? findZoneByMaPlayerId(leaderId) : selfZone;

    const membersRaw: unknown[] = Array.isArray(playerData.group_members) ? playerData.group_members : [];

    const memberZoneIds = normalizeMembers(membersRaw as any[], (m: any) => {
      const z =
        typeof m === 'string'
          ? findZoneByMaPlayerId(m)
          : typeof (m as { player_id?: string }).player_id === 'string'
            ? findZoneByMaPlayerId((m as { player_id: string }).player_id)
            : undefined;
      return z?.zoneId;
    });

    // Cancel any pending disband if a new or existing group is detected
    if (
      (leaderZone && selfZone.zoneId !== leaderZone.zoneId) ||
      memberZoneIds.length > 0
    ) {
      if (this.groupDisbandTimeout) {
        clearTimeout(this.groupDisbandTimeout);
        this.groupDisbandTimeout = undefined;
      }
      this.hasDisbanded = false;

      updateGroupFromBackend({
        adapter: backend,
        zoneName: this.zoneName,
        leaderZoneId: (leaderZone ?? selfZone).zoneId,
        memberZoneIds,
        externalId: leaderId,
      });
      return;
    }

    // Schedule disband only if we are the actual leader with no members
    if (memberZoneIds.length === 0 && leaderZone && selfZone.zoneId === leaderZone.zoneId) {
      const currentGroups = getCurrentGroups();
      const isRegisteredLeader = currentGroups.some((g) => g.leader === selfZone.zoneId);

      if (!this.groupDisbandTimeout && !this.hasDisbanded && isRegisteredLeader) {
        logger.debug(
          // eslint-disable-next-line max-len
          `[MusicAssistantStateMapper][${this.zoneName}] Scheduling possible disband (leader=${leaderZone.zoneId}) – members=${memberZoneIds.length}, debounce=${MusicAssistantStateMapper.DISBAND_DEBOUNCE_MS}ms`,
        );

        this.groupDisbandTimeout = setTimeout(async () => {
          this.groupDisbandTimeout = undefined;

          const removed = removeGroupByLeader(leaderZone.zoneId);
          if (removed) {
            logger.info(`[MusicAssistantStateMapper][${this.zoneName}] Group disbanded (leader=${leaderZone.zoneId})`);
          }

          this.activeGroupLeaderId = '';
          this.activeQueueId = '';
          this.hasDisbanded = true;

          try {
            await this.maybeRefreshFullState();
          } catch (err) {
            logger.warn(`[MusicAssistantStateMapper][${this.zoneName}] Failed to refresh state: ${(err as Error).message}`);
          }
        }, MusicAssistantStateMapper.DISBAND_DEBOUNCE_MS);
      }
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Utility Methods                                                            */
  /* -------------------------------------------------------------------------- */

  private pushPlayerStatusUpdate(patch: Partial<ZoneState>): void {
    try {
      this.updateHandler?.(patch);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[MusicAssistantStateMapper][${this.zoneName}] Failed to dispatch update: ${msg}`);
    }
  }

  private normalizeId(value: unknown): string {
    return value ? String(value).trim().toLowerCase() : '';
  }
}
