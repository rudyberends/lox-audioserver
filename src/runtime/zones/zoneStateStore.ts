import { deepStrictEqual } from 'assert';
import logger from '@/utils/troxorLogger';
import type { ZoneState, ZoneStatePatch } from './types/zoneStateTypes';
import { createDefaultZoneState } from './types/zoneStateTypes';
import { notifyQueueUpdated, notifyZoneStateChanged } from '@/http/loxoneHttp/websocketNotifier';

/**
 * -----------------------------------------------------------------------------
 * ZoneStateStore
 * -----------------------------------------------------------------------------
 * Canonical in-memory store for all zone/player states.
 *
 * Responsibilities:
 *  - Maintain authoritative zone state in memory
 *  - Apply patches and detect diffs
 *  - Broadcast `audio_event` updates for Loxone clients
 *  - Handle queue-specific updates (`audio_queue_event`)
 *  - Exclude internal-only fields (queue, adapterProps, updatedAt)
 * -----------------------------------------------------------------------------
 */
export class ZoneStateStore {
  private readonly states = new Map<number, ZoneState>();

  /** Fields that must NOT be sent to Loxone in audio_event broadcasts. */
  private static readonly EXCLUDED_BROADCAST_KEYS = new Set<keyof ZoneState>([
    'queue' as keyof ZoneState,
    'adapterProps' as keyof ZoneState,
    'updatedAt' as keyof ZoneState,
    'lastFavoriteId' as keyof ZoneState,
  ]);

  /* -------------------------------------------------------------------------- */
  /* Basic accessors                                                            */
  /* -------------------------------------------------------------------------- */

  public get(zoneId: number): ZoneState {
    const existing = this.states.get(zoneId);
    if (existing) {
      return existing;
    }

    const fresh = createDefaultZoneState(zoneId);
    this.states.set(zoneId, fresh);
    return fresh;
  }

  public entries(): IterableIterator<[number, ZoneState]> {
    return this.states.entries();
  }

  public getAll(): ZoneState[] {
    return Array.from(this.states.values()).map((s) => ({ ...s }));
  }

  public getZoneState(zoneId: number): ZoneState | undefined {
    return this.states.get(zoneId);
  }

  /* -------------------------------------------------------------------------- */
  /* State mutation                                                             */
  /* -------------------------------------------------------------------------- */

  public replace(zoneId: number, newState: ZoneState): void {
    this.states.set(zoneId, { ...newState });
    this.broadcast(zoneId);
  }

  /**
   * Apply a partial patch to an existing zone state.
   * Performs diff detection and only broadcasts if something actually changed.
   */
  public patch(zoneId: number, patch: ZoneStatePatch): void {
    const prev = this.get(zoneId);
    const next: ZoneState = { ...prev, ...patch };

    if (this.isEqual(prev, next)) {
      logger.silly?.(`[ZoneStateStore] No changes for zone ${zoneId}`);
      return;
    }

    this.states.set(zoneId, next);
    this.broadcast(zoneId, patch);

    // Automatically broadcast queue updates separately
    if ('queue' in patch && patch.queue) {
      notifyQueueUpdated(zoneId, patch.queue?.items?.length ?? 0);
    }
  }

  /**
   * Convenience helper for queue updates.
   * Stores queue in the zone state and automatically broadcasts the queue event.
   */
  public pushQueueUpdate(zoneId: number, queue: any): void {
    try {
      const current = this.get(zoneId);
      const next = { ...current, queue };
      this.states.set(zoneId, next);

      const queueSize = Array.isArray(queue?.items) ? queue.items.length : 0;
      logger.info(`[ZoneStateStore] Received queue update for zone ${zoneId} (${queueSize} items)`);

      notifyQueueUpdated(zoneId, queue?.items?.length ?? 0);
    } catch (err) {
      logger.warn(`[ZoneStateStore] Failed to push queue update for zone ${zoneId}: ${String(err)}`);
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Internal helpers                                                           */
  /* -------------------------------------------------------------------------- */

  private broadcast(zoneId: number, changed?: ZoneStatePatch): void {
    const state = this.states.get(zoneId);
    if (!state) {
      return;
    }

    const sanitized = this.sanitizeForBroadcast(state);
    notifyZoneStateChanged(zoneId, sanitized);
  }


  private isEqual(a: ZoneState, b: ZoneState): boolean {
    try {
      deepStrictEqual(a, b);
      return true;
    } catch {
      return false;
    }
  }

  private sanitizeForBroadcast(state: ZoneState): Partial<ZoneState> {
    const sanitized: Partial<ZoneState> = {};
    for (const [key, value] of Object.entries(state)) {
      if (!ZoneStateStore.EXCLUDED_BROADCAST_KEYS.has(key as keyof ZoneState)) {
        sanitized[key as keyof ZoneState] = value;
      }
    }
    return sanitized;
  }

  /* -------------------------------------------------------------------------- */
  /* Lifecycle management                                                       */
  /* -------------------------------------------------------------------------- */

  public delete(zoneId: number): void {
    this.states.delete(zoneId);
    logger.info(`[ZoneStateStore] Zone ${zoneId} removed`);
  }

  public clear(): void {
    this.states.clear();
    logger.info('[ZoneStateStore] Cleared all zone states');
  }
}

/** Singleton export for global use. */
export const zoneStateStore = new ZoneStateStore();