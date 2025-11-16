import logger from '@/utils/troxorLogger';
import { zoneRuntime } from '@/runtime/zones/zoneRuntime';
import type { ZoneState } from '@/runtime/zones/types/zoneStateTypes';
import type { AlertMediaResource } from './types/AlertTypes';

/**
 * -----------------------------------------------------------------------------
 * AlertPlaybackEngine
 * -----------------------------------------------------------------------------
 * Low-level execution of alert playback (per zone).
 *
 * Responsibilities:
 *  - Save original volume once per zone
 *  - Set alert volume using absolute mode
 *  - Trigger announcement playback
 *  - Provide a Promise that resolves when playback completes (for TTS)
 *  - Restore volume afterwards
 * -----------------------------------------------------------------------------
 */
export class AlertPlaybackEngine {
  private readonly saved = new Map<number, { volume: number }>();

  /** Save original state once per zone. */
  public saveState(zoneId: number, state: ZoneState): void {
    if (!this.saved.has(zoneId)) {
      this.saved.set(zoneId, { volume: state.volume });
    }
  }

  /**
   * Start alert playback for a single zone.
   *
   * Returns a Promise that resolves when:
   *  - volume is set, and
   *  - the underlying announcement playback has completed.
   */
  public async startAlert(
    zoneId: number,
    type: string,
    media: AlertMediaResource,
    alertVolume: number,
  ): Promise<void> {
    const state = zoneRuntime.getZoneState(zoneId);
    if (state) {
      this.saveState(zoneId, state);
    }

    // 1. Apply absolute alert volume
    await zoneRuntime.sendZoneCommand(zoneId, 'volume', { absolute: alertVolume });
    logger.debug(`[AlertPlaybackEngine] Zone ${zoneId} → alert volume ${alertVolume}`);

    // 2. Trigger announcement playback and wait until it finishes
    await zoneRuntime.sendZoneCommand(zoneId, 'announce', { url: media.url });

    logger.info(`[AlertPlaybackEngine] Alert "${type}" started on zone ${zoneId}`);
  }

  /** Pause alert playback (no-op if mapper ignores it). */
  public async stopAlert(zoneId: number, type: string): Promise<void> {
  // TTS en announcements mogen nooit pauze veroorzaken
    if (type === 'tts') {
      logger.debug(`[AlertPlaybackEngine] skip pause for TTS on zone ${zoneId}`);
      return;
    }

    // Echte alerts mogen wél pauzeren
    try {
      await zoneRuntime.sendZoneCommand(zoneId, 'pause');
      logger.debug(`[AlertPlaybackEngine] Zone ${zoneId} paused (alert stop)`);
    } catch (err) {
      logger.warn(`[AlertPlaybackEngine] Failed to pause zone ${zoneId}: ${String(err)}`);
    }
  }

  /** Restore saved volume, if any. */
  public async restoreVolume(zoneId: number): Promise<void> {
    const saved = this.saved.get(zoneId);
    if (!saved) {
      return;
    }

    try {
      await zoneRuntime.sendZoneCommand(zoneId, 'volume', { absolute: saved.volume });
      logger.info(`[AlertPlaybackEngine] Restored volume ${saved.volume} on zone ${zoneId}`);
    } catch (err) {
      logger.warn(`[AlertPlaybackEngine] Failed to restore volume for zone ${zoneId}: ${String(err)}`);
    }

    this.saved.delete(zoneId);
  }
}