import logger from '@/utils/troxorLogger';
import type { ZoneState } from '@/runtime/zones/types/zoneStateTypes';
import { AudioPlaybackMode } from '@/core/loxone/types';
import { zoneStateStore } from '@/runtime/zones/zoneStateStore';
import { MusicAssistantApi } from '../api';
import type { MusicAssistantConfig } from '../types/config';
import type { EventMessage } from '../api/types';
import { mapPlayerToState, mapQueueItem, mapQueueToState } from './stateMapper';
import type { Player, PlayerQueue } from '../types/musicAssistantTypes';
import { StateMapper } from '@/core/interfaces/stateMapper';

/**
 * -----------------------------------------------------------------------------
 * MusicAssistantStateMapper
 * -----------------------------------------------------------------------------
 * Maps Music Assistant state into Loxone ZoneRuntime.
 *
 * Behaviour:
 * - Each mapper controls exactly one MA player/queue identified by `maPlayerId`.
 * - Only events whose object_id or data.object_id match this id are processed.
 * - Player state and queue structure are always fetched and normalised.
 * - Playback time is maintained using event updates and timestamp deltas.
 * - Queue items are always retrieved from the backend when needed.
 *
 * Guarantees:
 * - Deterministic filtering (no cross-zone state leakage).
 * - Lossless event translation.
 * - Predictable queue and metadata synchronisation.
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

  private lastQueueUpdateTs = 0;

  private static readonly TIMING = {
    QUEUE_UPDATE_DEBOUNCE_MS: 250,
  };

  constructor(params: MusicAssistantConfig) {
    this.zoneId = params.zoneId;
    this.zoneName = params.zoneName;
    this.maPlayerId = params.maPlayerId.toLowerCase();
    this.api = MusicAssistantApi.acquire(params.ip, params.port ?? 8095);
  }

  /* -------------------------------------------------------------------------- */
  /* Lifecycle                                                                  */
  /* -------------------------------------------------------------------------- */

  /**
   * Establishes backend connectivity, loads the initial player and queue state,
   * applies all mapping logic, and starts listening for state events.
   */
  async initialize(): Promise<void> {
    await this.api.connect();

    try {
      const player = await this.api.getPlayer(this.maPlayerId);
      if (player) {
        zoneStateStore.patch(this.zoneId, mapPlayerToState(this.zoneId, player));
      }

      const queue = await this.api.getQueue(this.maPlayerId);
      if (queue) {
        const items = await this.api.getQueueItems(this.maPlayerId);
        (queue as any).items = Array.isArray(items) ? items : [];

        const mapped = mapQueueToState(this.zoneId, queue);
        if (mapped) {
          zoneStateStore.patch(this.zoneId, {
            ...mapped.trackUpdate,
            queue: mapped.queue,
          });
        }
      }

      this.log('info', `Initial state loaded for ${this.zoneName}`);
    } catch (err) {
      this.log('warn', `Initial state load failed: ${String(err)}`);
    }

    const unsub = this.api.onEvent((evt) => this.handleEvent(evt));

    if (typeof unsub === 'function') {
      this.unsubscribe = unsub;
    } else {
      this.log('warn', 'Invalid unsubscribe handler returned by MusicAssistantApi');
    }
  }

  /**
   * Stops event processing and releases the shared API instance.
   */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;

    this.api.release();
    this.log('info', 'StateMapper disposed');
  }

  /**
   * Registers a callback that receives incremental updates for live state.
   */
  onUpdate(handler: (update: Partial<ZoneState>) => void): void {
    this.updateHandler = handler;
  }

  /* -------------------------------------------------------------------------- */
  /* Event Handling                                                             */
  /* -------------------------------------------------------------------------- */

  /**
   * Handles inbound Music Assistant events, applying strict filtering rules:
   * - `object_id` must equal this.maPlayerId, or
   * - if no object_id is present, `data.player_id` must match.
   */
  private handleEvent(evt: EventMessage): void {
    const objectId = String(evt.object_id ?? '').toLowerCase();
    const eventType = String(evt.event ?? '').toLowerCase();

    // Reject events for other players/queues
    if (objectId && objectId !== this.maPlayerId) {
      return;
    }
    if (!objectId) {
      const idFromData = evt.data?.player_id ?? evt.data?.queue_id;
      if (idFromData && String(idFromData).toLowerCase() !== this.maPlayerId) {
        return;
      }
    }

    switch (eventType) {
      case 'queue_items_updated':
        void this.refreshQueue();
        break;

      case 'queue_updated':
      case 'queue_added':
        void this.updateFromQueue(evt.data as PlayerQueue);
        break;

      case 'player_updated':
      case 'player_added':
        this.updateFromPlayer(evt.data as Player);
        break;

      case 'queue_time_updated':
        this.updateQueueTime(evt.data);
        break;
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Queue Handling                                                             */
  /* -------------------------------------------------------------------------- */

  /**
   * Retrieves the complete queue from the backend, including all items,
   * normalises them, sorts them, and stores the result in the ZoneRuntime.
   */
  private async refreshQueue(): Promise<void> {
    try {
      const items = await this.api.getQueueItems(this.maPlayerId);
      logger.debug('!! ma-queue items!');
      logger.debug(JSON.stringify(items));
      logger.debug('!! ma-queue items!');
      const mappedItems = Array.isArray(items)
        ? items.map((it, i) => mapQueueItem(it, i))
        : [];

      // Ensure deterministic ordering
      mappedItems.sort((a, b) => (a.qindex ?? 0) - (b.qindex ?? 0));

      const prev = zoneStateStore.get(this.zoneId)?.queue?.shuffle;

      const queue: ZoneState['queue'] = {
        id: this.zoneId,
        items: mappedItems,
        shuffle: prev ?? false,
        start: 0,
        totalitems: mappedItems.length,
      };

      zoneStateStore.patch(this.zoneId, { queue });
      this.log('debug', `Queue refreshed (${mappedItems.length} items)`);
    } catch (err) {
      this.log('warn', `Queue refresh failed: ${String(err)}`);
    }
  }

  /**
   * Processes incoming queue metadata, fetches the full item list,
   * applies mapped metadata and the full queue content.
   */
  private async updateFromQueue(queueData: PlayerQueue): Promise<void> {
    const now = Date.now();
    if (now - this.lastQueueUpdateTs < MusicAssistantStateMapper.TIMING.QUEUE_UPDATE_DEBOUNCE_MS) {
      return;
    }
    this.lastQueueUpdateTs = now;

    try {
      const mappedMeta = mapQueueToState(this.zoneId, queueData);

      const items = await this.api.getQueueItems(this.maPlayerId);
      logger.debug('!! ma-queue items!');
      logger.debug(JSON.stringify(items));
      logger.debug('!! ma-queue items!');
      const mappedItems = Array.isArray(items)
        ? items.map((it, i) => mapQueueItem(it, i))
        : [];

      mappedItems.sort((a, b) => (a.qindex ?? 0) - (b.qindex ?? 0));

      const prevShuffle = zoneStateStore.get(this.zoneId)?.queue?.shuffle;

      const queue: ZoneState['queue'] = {
        id: this.zoneId,
        items: mappedItems,
        shuffle: mappedMeta?.queue?.shuffle ?? prevShuffle ?? false,
        start: 0,
        totalitems: mappedItems.length,
      };

      zoneStateStore.patch(this.zoneId, {
        ...(mappedMeta?.trackUpdate ?? {}),
        queue,
      });

      this.log('debug', `Queue updated (${mappedItems.length} items)`);
    } catch (err) {
      this.log('warn', `Queue update failed: ${String(err)}`);
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Player Handling                                                            */
  /* -------------------------------------------------------------------------- */

  /**
   * Translates player state updates into ZoneRuntime patches.
   */
  private updateFromPlayer(player: Player): void {
    try {
      const patch = mapPlayerToState(this.zoneId, player);
      this.push(patch);
    } catch (err) {
      this.log('warn', `Player update failed: ${String(err)}`);
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Playback Time Handling                                                     */
  /* -------------------------------------------------------------------------- */

  /**
   * Updates playback position. Supports both raw seconds and timestamp delta.
   */
  private updateQueueTime(value: any): void {
    const seconds = Number(value ?? 0);
    if (!Number.isFinite(seconds)) {
      return;
    }

    this.push({
      time: seconds,
      position_ms: Math.round(seconds * 1000),
      ...(seconds === 0 ? { mode: AudioPlaybackMode.Pause } : {}),
    });
  }

  /* -------------------------------------------------------------------------- */
  /* Utilities                                                                  */
  /* -------------------------------------------------------------------------- */

  /**
   * Emits a partial update into the ZoneRuntime update handler.
   */
  private push(patch: Partial<ZoneState>): void {
    try {
      this.updateHandler?.(patch);
    } catch (err) {
      this.log('warn', `Update dispatch failed: ${String(err)}`);
    }
  }

  /**
   * Logs messages with consistent prefix and zone context.
   */
  private log(level: 'info' | 'warn' | 'debug', msg: string): void {
    logger[level](`[MusicAssistantStateMapper][${this.zoneName}] ${msg}`);
  }
}