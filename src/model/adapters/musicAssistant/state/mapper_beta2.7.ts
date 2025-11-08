import logger from '@/utils/troxorLogger';
import type { ZoneState } from '@/runtime/zones/types/zoneStateTypes';
import { AudioPlaybackMode } from '@/core/loxone/types';
import { zoneStateStore } from '@/runtime/zones/zoneStateStore';
import { removeGroupByLeader, getCurrentGroups } from '@/runtime/groups/groupTracker';
import { MusicAssistantApi } from '../api';
import type { MusicAssistantConfig } from '../types/config';
import type { EventMessage } from '../api/types';
import { findZoneByMaPlayerId } from '../utils/findZoneByMaPlayerId';
import { mapPlayerToState, mapQueueItem, mapQueueToState } from './stateMapper';
import type { Player, PlayerQueue } from '../types/musicAssistantTypes';
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
  private hasDisbanded = false;
  private lastRefreshTs = 0;
  private lastQueueUpdateTs = 0;

  private static readonly TIMING = {
    DISBAND_REFRESH_COOLDOWN_MS: 15000,
    QUEUE_UPDATE_DEBOUNCE_MS: 500,
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

  async initialize(): Promise<void> {
    await this.api.connect();

    try {
      const queues = await this.api.getAllQueues();
      const myQueue =
        queues.find(q => q.queue_id === this.maPlayerId) ??
        queues.find(q => q.queue_id === this.activeQueueId);

      if (myQueue?.queue_id) {
        const items = await this.api.getQueueItems(myQueue.queue_id);
        if (Array.isArray(items) && items.length > 0) {
          (myQueue as { items: unknown[] }).items = items;
        }
        await this.updateFromQueue(myQueue);
      }
    } catch (err) {
      this.logWarn('Initial queue fetch failed', err);
    }

    this.unsubscribe = this.api.onEvent(evt => this.handleEvent(evt));
    await this.api.refreshFullState();

    this.log('info', `StateMapper initialized for ${this.maPlayerId}`);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;

    if (this.groupDisbandTimeout) {
      clearTimeout(this.groupDisbandTimeout);
    }

    this.api.release();
    this.log('info', 'StateMapper disposed');
  }

  onUpdate(handler: (update: Partial<ZoneState>) => void): void {
    this.updateHandler = handler;
  }

  /* -------------------------------------------------------------------------- */
  /* Event Routing                                                              */
  /* -------------------------------------------------------------------------- */

  private handleEvent(evt: EventMessage): void {
    const eventName = String(evt.event ?? '').toLowerCase();
    if (!this.isEventRelevant(eventName, evt.object_id)) {
      return;
    }

    this.log('debug', `stateUpdate received (${eventName})`);

    switch (eventName) {
      case 'queue_items_updated':
        void this.refreshQueueItems(evt.data?.queue_id);
        break;
      case 'queue_added':
        void this.updateFromQueue(evt.data);
        break;
      case 'queue_updated':
        void this.updateQueueMetadata(evt.data);
        break;
      case 'queue_time_updated':
        this.handleQueueTime(evt.data);
        break;
      case 'player_added':
      case 'player_updated':
        this.updateFromPlayer(evt.data);
        break;
      default:
        break;
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Queue and Player Mapping                                                   */
  /* -------------------------------------------------------------------------- */

  private updateQueueMetadata(queueData: PlayerQueue): void {
    try {
      const repeat = String(queueData.repeat_mode ?? '').toLowerCase();
      const repeatMode = repeat === 'one' ? 2 : repeat === 'all' ? 1 : 0;
      const shuffle = queueData.shuffle_enabled ? 1 : 0;

      const patch: Partial<ZoneState> = {
        plrepeat: repeatMode,
        plshuffle: shuffle,
      };

      this.pushPlayerStatusUpdate(patch);
      this.log('debug', `Queue metadata updated (shuffle=${shuffle}, repeat=${repeat})`);
    } catch (err) {
      this.logWarn('updateQueueMetadata failed', err);
    }
  }

  private async refreshQueueItems(queueId?: string): Promise<void> {
    const id = this.normalizeId(queueId ?? this.activeQueueId);
    if (!id) {
      return;
    }

    try {
      const items = await this.api.getQueueItems(id);
      if (!Array.isArray(items) || items.length === 0) {
        this.log('debug', 'refreshQueueItems: no items returned');
        return;
      }

      const mappedItems = items.map((item, i) => mapQueueItem(item, i));

      const newQueue: ZoneState['queue'] = {
        id: this.zoneId!,
        items: mappedItems,
        shuffle: false, // shuffle wordt later via queue_updated event gezet
        start: 0,
        totalitems: mappedItems.length,
      };

      // Patch direct naar de store
      zoneStateStore.patch(this.zoneId!, { queue: newQueue });

      this.log('info', `Queue rebuilt (${mappedItems.length} items)`);
    } catch (err) {
      this.logWarn('refreshQueueItems failed', err);
    }
  }

  private async updateFromQueue(queueData: PlayerQueue): Promise<void> {
    if (!queueData?.queue_id) {
      return;
    }
    if (!this.shouldProcessQueueUpdate()) {
      return;
    }

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

      this.log(
        'info',
        `Queue updated (${mapped.queue!.totalitems} items, shuffle=${mapped.queue!.shuffle})`,
      );
    } catch (err) {
      this.logWarn('updateFromQueue failed', err);
    }
  }

  private updateFromPlayer(playerData: Player): void {
    try {
      this.activeGroupLeaderId = this.normalizeId(playerData.synced_to);
      const patch = mapPlayerToState(this.zoneId!, playerData);
      this.pushPlayerStatusUpdate(patch);
      this.syncGroupMembership(playerData);
    } catch (err) {
      this.logWarn('updateFromPlayer failed', err);
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Group Synchronization Logic                                                */
  /* -------------------------------------------------------------------------- */

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

    const rawLeaderId = playerData.synced_to;
    const leaderId = this.normalizeId(rawLeaderId ?? this.maPlayerId);
    const leaderZone = rawLeaderId ? findZoneByMaPlayerId(leaderId) : selfZone;
    const membersRaw = playerData.group_members ?? [];

    const memberZoneIds = normalizeMembers(membersRaw, (m: any) => {
      const z =
        typeof m === 'string'
          ? findZoneByMaPlayerId(m)
          : typeof m?.player_id === 'string'
            ? findZoneByMaPlayerId(m.player_id)
            : undefined;
      return z?.zoneId;
    });

    // If new or existing group detected → cancel pending disband
    if ((leaderZone && selfZone.zoneId !== leaderZone.zoneId) || memberZoneIds.length > 0) {
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

    // Schedule disband only if we are leader with no members
    if (memberZoneIds.length === 0 && leaderZone && selfZone.zoneId === leaderZone.zoneId) {
      const currentGroups = getCurrentGroups();
      const isRegisteredLeader = currentGroups.some(g => g.leader === selfZone.zoneId);

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
        }, 1000);
      }
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Utility Methods                                                            */
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

  private shouldProcessQueueUpdate(): boolean {
    const now = Date.now();
    if (now - this.lastQueueUpdateTs < MusicAssistantStateMapper.TIMING.QUEUE_UPDATE_DEBOUNCE_MS) {
      return false;
    }
    this.lastQueueUpdateTs = now;
    return true;
  }

  private async maybeRefreshFullState(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRefreshTs < MusicAssistantStateMapper.TIMING.DISBAND_REFRESH_COOLDOWN_MS) {
      return;
    }
    await this.api.refreshFullState();
    this.lastRefreshTs = now;
    this.log('debug', 'Full state refreshed after disband');
  }

  private pushPlayerStatusUpdate(patch: Partial<ZoneState>): void {
    try {
      this.updateHandler?.(patch);
    } catch (err) {
      this.logWarn('Failed to dispatch update', err);
    }
  }

  private isEventRelevant(event: string, objectId?: string): boolean {
    const id = this.normalizeId(objectId);
    const relevant = new Set(
      [this.maPlayerId, this.activeQueueId, this.activeGroupLeaderId]
        .map(i => this.normalizeId(i))
        .filter(Boolean),
    );
    if (!id && (event.startsWith('queue_') || event.startsWith('player_'))) {
      return false;
    }
    return !id || relevant.has(id);
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
