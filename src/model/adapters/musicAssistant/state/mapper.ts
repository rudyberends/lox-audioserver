import logger from '@/utils/troxorLogger';
import type { ZoneState } from '@/runtime/zones/types/zoneStateTypes';
import { AudioPlaybackMode } from '@/core/loxone/types';
import { zoneStateStore } from '@/runtime/zones/zoneStateStore';
import { removeGroupByLeader, getCurrentGroups } from '@/runtime/groups/groupTracker';
import { MusicAssistantApi } from '../api';
import type { MusicAssistantConfig } from '../types/config';
import type { EventMessage } from '../api/types';
import { findZoneByMaPlayerId } from '../utils/findZoneByMaPlayerId';
import { mapPlayerToState, mapQueueItem, mapQueueToState } from '../mappers/stateMapper';
import type { Player, PlayerQueue } from '../types/musicAssistantTypes';
import { normalizeMembers, updateGroupFromBackend } from '@/runtime/zones/utils/groupUtils';
import { StateMapper } from '@/core/interfaces/stateMapper';

/**
 * -----------------------------------------------------------------------------
 * MusicAssistantStateMapper
 * -----------------------------------------------------------------------------
 * Handles synchronization of player and queue states from Music Assistant
 * into the Loxone ZoneRuntime. Fetches the initial backend state on startup
 * and keeps it updated through event-driven updates.
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

  private hasDisbanded = false;
  private lastRefreshTs = 0;
  private lastQueueUpdateTs = 0;

  private static readonly TIMING = {
    DISBAND_REFRESH_COOLDOWN_MS: 15_000,
    QUEUE_UPDATE_DEBOUNCE_MS: 500,
    DISBAND_DEBOUNCE_MS: 2_500,
  };

  constructor(params: MusicAssistantConfig) {
    this.zoneId = params.zoneId;
    this.zoneName = params.zoneName;
    this.maPlayerId = params.maPlayerId;
    this.api = MusicAssistantApi.acquire(params.ip, params.port ?? 8095);
  }

  /* -------------------------------------------------------------------------- */
  /* Lifecycle                                                                  */
  /* -------------------------------------------------------------------------- */

  /**
   * Initializes the mapper, connects to Music Assistant, and loads
   * the initial state (player + queue) from the backend before subscribing to events.
   */
  async initialize(): Promise<void> {
    await this.api.connect();

    try {
      // (1) Fetch player state
      const player = await this.api.getPlayer(this.maPlayerId);

      // (2) Resolve queue related to this player
      const queues = await this.api.getAllQueues();
      const lowerId = this.maPlayerId.toLowerCase();
      const myQueue: PlayerQueue | undefined =
        queues.find((q: any) => q.player_id?.toLowerCase?.() === lowerId) ??
        queues.find(
          (q: any) =>
            Array.isArray(q.players) &&
            q.players.map((p: any) => String(p).toLowerCase()).includes(lowerId),
        ) ??
        queues.find((q: any) => String(q.state).toLowerCase() === 'playing');

      if (myQueue?.queue_id) {
        const items = await this.api.getQueueItems(myQueue.queue_id);
        if (Array.isArray(items)) {
          (myQueue as any).items = items;
        }

        const mapped = mapQueueToState(this.zoneId, myQueue);
        if (mapped) {
          zoneStateStore.patch(this.zoneId, { ...mapped.trackUpdate, queue: mapped.queue });
          this.activeQueueId = myQueue.queue_id.toLowerCase();
        }
      }

      // (3) Apply player-specific state last so it overwrites queue-based metadata
      if (player) {
        const patch = mapPlayerToState(this.zoneId, player);
        zoneStateStore.patch(this.zoneId, patch);
      }

      this.log('info', `Initial state loaded for ${this.zoneName}`);
    } catch (err) {
      this.logWarn('Initial state fetch failed', err);
    }

    // (4) Subscribe to all backend events
    this.unsubscribe = this.api.onEvent((evt: EventMessage) => this.handleEvent(evt));

    // (5) Request a full sync for consistency
    await this.api.refreshFullState();
  }

  /** Disconnects mapper, cancels timers, and releases resources. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;

    if (this.groupDisbandTimeout) {
      clearTimeout(this.groupDisbandTimeout);
      this.groupDisbandTimeout = undefined;
    }

    this.api.release();
    this.log('info', 'StateMapper disposed');
  }

  onUpdate(handler: (update: Partial<ZoneState>) => void): void {
    this.updateHandler = handler;
  }

  /* -------------------------------------------------------------------------- */
  /* Event Handling                                                             */
  /* -------------------------------------------------------------------------- */

  private handleEvent(evt: EventMessage): void {
    const eventName = String(evt.event ?? '').toLowerCase();
    const objectId = this.normalizeId(evt.object_id);

    // Allow events without object_id
    if (objectId) {
      const relevant = new Set(
        [this.maPlayerId, this.activeQueueId, this.activeGroupLeaderId].map(this.normalizeId),
      );
      if (!relevant.has(objectId)) {
        return;
      }
    }

    switch (eventName) {
      case 'queue_items_updated':
        void this.refreshQueueItems(evt.data?.queue_id);
        break;

      case 'queue_updated':
      case 'queue_added':
        void this.updateFromQueue(evt.data as PlayerQueue);
        if (!Array.isArray((evt.data as PlayerQueue)?.items)) {
          void this.refreshQueueItems((evt.data as PlayerQueue)?.queue_id);
        }
        break;

      case 'player_updated':
      case 'player_added':
        this.updateFromPlayer(evt.data as Player);
        break;

      case 'queue_time_updated':
        this.handleQueueTime(evt.data);
        break;

      default:
        break;
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Queue Handling                                                             */
  /* -------------------------------------------------------------------------- */

  private async refreshQueueItems(queueId?: string): Promise<void> {
    const id = this.normalizeId(queueId ?? this.activeQueueId);
    if (!id) {
      return;
    }

    try {
      const items = await this.api.getQueueItems(id);
      const mappedItems = Array.isArray(items) ? items.map((item, i) => mapQueueItem(item, i)) : [];

      const newQueue: ZoneState['queue'] = {
        id: this.zoneId,
        items: mappedItems,
        shuffle: zoneStateStore.get(this.zoneId)?.queue?.shuffle ?? false,
        start: 0,
        totalitems: mappedItems.length,
      };

      zoneStateStore.patch(this.zoneId, { queue: newQueue });
      this.log('info', `Queue refreshed (${mappedItems.length} items)`);
    } catch (err) {
      this.logWarn('refreshQueueItems failed', err);
    }
  }

  private async updateFromQueue(queueData: PlayerQueue): Promise<void> {
    if (!queueData?.queue_id) {
      return;
    }

    const now = Date.now();
    if (now - this.lastQueueUpdateTs < MusicAssistantStateMapper.TIMING.QUEUE_UPDATE_DEBOUNCE_MS) {
      return;
    }
    this.lastQueueUpdateTs = now;

    try {
      const mapped = mapQueueToState(this.zoneId, queueData);
      if (!mapped) {
        return;
      }

      this.activeQueueId = this.normalizeId(queueData.queue_id);
      zoneStateStore.patch(this.zoneId, { ...mapped.trackUpdate, queue: mapped.queue });

      this.log('info', `Queue updated (${mapped.queue?.totalitems} items, shuffle=${mapped.queue?.shuffle})`);
    } catch (err) {
      this.logWarn('updateFromQueue failed', err);
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Player Handling                                                            */
  /* -------------------------------------------------------------------------- */

  private updateFromPlayer(playerData: Player): void {
    try {
      this.activeGroupLeaderId = this.normalizeId(playerData.synced_to);

      const patch = mapPlayerToState(this.zoneId, playerData);
      this.pushPlayerStatusUpdate(patch);

      // If synced to a leader, refresh that leader's queue
      if (this.activeGroupLeaderId) {
        void this.refreshQueueItems(this.activeGroupLeaderId);
      }

      this.syncGroupMembership(playerData);
    } catch (err) {
      this.logWarn('updateFromPlayer failed', err);
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Group Synchronization                                                      */
  /* -------------------------------------------------------------------------- */

  private async maybeRefreshFullState(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRefreshTs < MusicAssistantStateMapper.TIMING.DISBAND_REFRESH_COOLDOWN_MS) {
      return;
    }
    await this.api.refreshFullState();
    this.lastRefreshTs = now;
    this.log('debug', 'Full state refreshed after disband');
  }

  private syncGroupMembership(playerData: Player): void {
    const backend = 'MusicAssistant' as const;
    const selfZone = findZoneByMaPlayerId(this.maPlayerId);
    if (!selfZone) {
      return;
    }

    const rawLeaderId = playerData.synced_to ?? null;
    const leaderId = this.normalizeId(rawLeaderId ?? this.maPlayerId);
    const leaderZone = rawLeaderId ? findZoneByMaPlayerId(leaderId) : selfZone;

    const membersRaw = Array.isArray(playerData.group_members) ? playerData.group_members : [];
    const memberZoneIds = normalizeMembers(membersRaw as any[], (m: any) => {
      const z =
        typeof m === 'string'
          ? findZoneByMaPlayerId(m)
          : typeof m?.player_id === 'string'
            ? findZoneByMaPlayerId(m.player_id)
            : undefined;
      return z?.zoneId;
    });

    if ((leaderZone && selfZone.zoneId !== leaderZone.zoneId) || memberZoneIds.length > 0) {
      if (this.groupDisbandTimeout) {
        clearTimeout(this.groupDisbandTimeout);
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

    if (memberZoneIds.length === 0 && leaderZone && selfZone.zoneId === leaderZone.zoneId) {
      const currentGroups = getCurrentGroups();
      const isRegisteredLeader = currentGroups.some((g) => g.leader === selfZone.zoneId);

      if (!this.groupDisbandTimeout && !this.hasDisbanded && isRegisteredLeader) {
        this.groupDisbandTimeout = setTimeout(async () => {
          this.groupDisbandTimeout = undefined;

          const removed = removeGroupByLeader(leaderZone.zoneId);
          if (removed) {
            this.log('info', `Group disbanded (leader=${leaderZone.zoneId})`);
          }

          this.activeGroupLeaderId = '';
          this.activeQueueId = '';
          this.hasDisbanded = true;

          try {
            await this.maybeRefreshFullState();
          } catch (err) {
            this.logWarn('Failed to refresh state', err);
          }
        }, MusicAssistantStateMapper.TIMING.DISBAND_DEBOUNCE_MS);
      }
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Utilities                                                                  */
  /* -------------------------------------------------------------------------- */

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

  private pushPlayerStatusUpdate(patch: Partial<ZoneState>): void {
    try {
      this.updateHandler?.(patch);
    } catch (err) {
      this.logWarn('Failed to dispatch update', err);
    }
  }

  private normalizeId(value: unknown): string {
    return value ? String(value).trim().toLowerCase() : '';
  }

  private log(level: 'info' | 'warn' | 'debug', msg: string): void {
    logger[level](`[MusicAssistantStateMapper][${this.zoneName}] ${msg}`);
  }

  private logWarn(scope: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.log('warn', `${scope}: ${msg}`);
  }
}