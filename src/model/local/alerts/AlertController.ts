import logger from '@/utils/troxorLogger';
import type { AlertMediaResource } from './types/AlertTypes';
import { AlertPlaybackEngine } from './AlertPlaybackEngine';
import { zoneStateStore } from '@/runtime/zones/zoneStateStore';

/**
 * -----------------------------------------------------------------------------
 * AlertController
 * -----------------------------------------------------------------------------
 * High-level orchestration of alert lifecycle per zone.
 *
 * For each zone:
 *  - Start alert (volume + playback) → returns Promise<void>
 *  - When the Promise resolves, stop + restore volume for that zone
 * -----------------------------------------------------------------------------
 */
export class AlertController {
  constructor(
    private readonly engine: AlertPlaybackEngine,
  ) {}

  public async alertStart(
    zoneIds: number[],
    type: string,
    media: AlertMediaResource,
    resolveVolume: (z: number) => number,
  ): Promise<void> {
    for (const zoneId of zoneIds) {
      const state = zoneStateStore.getZoneState(zoneId);
      if (!state) {
        logger.warn(`[AlertController] Unknown zone ${zoneId}`);
        continue;
      }

      const alertVol = resolveVolume(zoneId);

      const playbackPromise = this.engine.startAlert(zoneId, type, media, alertVol);

      playbackPromise
        .then(() => this.alertStop([zoneId], type))
        .catch((err: unknown) => {
          logger.warn(
            `[AlertController] Playback failed for zone ${zoneId}: ${String(err)}`,
          );
          return this.alertStop([zoneId], type);
        });
    }
  }

  public async alertStop(zoneIds: number[], type: string): Promise<void> {
    for (const zoneId of zoneIds) {
      try {
        await this.engine.stopAlert(zoneId, type);
      } catch (err) {
        logger.warn(
          `[AlertController] stopAlert failed for zone ${zoneId}: ${String(err)}`,
        );
      }

      try {
        await this.engine.restoreVolume(zoneId);
      } catch (err) {
        logger.warn(
          `[AlertController] restoreVolume failed for zone ${zoneId}: ${String(err)}`,
        );
      }
    }
  }
}