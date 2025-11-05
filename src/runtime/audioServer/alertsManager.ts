import logger from '@/utils/troxorLogger';
import { zoneRuntime } from '@/runtime/zones/zoneRuntime';
import type { AlertMediaResource } from '@/model/local/alerts/types';
import { FileAlertProvider } from '@/model/local/alerts/alerts/fileAlertsProvider';
import { GoogleTtsProvider } from '@/model/local/alerts/tts/googleTtsProvder';
import { RepeatMode } from '@/core/loxone/types';

const LOOPED_ALERTS = new Set(['alarm', 'firealarm', 'buzzer']);

/**
 * -----------------------------------------------------------------------------
 * AlertsManager
 * -----------------------------------------------------------------------------
 * Huidige implementatie zonder groepslogica.
 * Stuurt alerts direct naar elke zone, net als in de oude handler.
 * -----------------------------------------------------------------------------
 */
export class AlertsManager {
  private readonly fileProvider = new FileAlertProvider();
  private readonly ttsProvider = new GoogleTtsProvider();
  private readonly loopState = new Map<string, RepeatMode | undefined>();

  /**
   * Handles a grouped alert command, but sends playback directly to each zone.
   */
  public async handleGroupedAlert(
    leaderId: number,
    type: string,
    action: 'on' | 'off',
    targetZones?: number[],
    ttsText?: string,
    ttsLang?: string,
  ): Promise<{ success: boolean; type: string; action: string; reason?: string }> {
    logger.info(`[AlertsManager] ${action.toUpperCase()} alert "${type}"`);

    const zones = targetZones?.length ? targetZones : [leaderId];

    // stop alert
    if (action === 'off') {
      await this.stopAlert(zones, type);
      return { success: true, type, action };
    }

    // resolve media
    const media = await this.resolveMedia(type, ttsText, ttsLang);
    if (!media) {
      logger.warn(`[AlertsManager] No media found for alert type "${type}"`);
      return { success: false, type, action, reason: 'media-unavailable' };
    }

    // play media per zone
    await Promise.all(
      zones.map(async (zoneId) => {
        const state = zoneRuntime.getZoneState(zoneId);
        if (!state) {
          logger.warn(`[AlertsManager] Unknown zone ${zoneId}`);
          return;
        }
        try {
          await this.playAlert(zoneId, type, media);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`[AlertsManager] Failed to start alert on zone ${zoneId}: ${msg}`);
        }
      }),
    );
    return { success: true, type, action };
  }

  /* ------------------------------------------------------------------------ */
  /*  Provider resolution                                                     */
  /* ------------------------------------------------------------------------ */

  private async resolveMedia(
    type: string,
    ttsText?: string,
    ttsLang?: string,
  ): Promise<AlertMediaResource | undefined> {
    if (type === 'tts') {
      if (!ttsText) {
        logger.warn('[AlertsManager] TTS alert requested without text');
        return undefined;
      }
      return this.ttsProvider.generate(ttsText, ttsLang || 'en');
    }
    return this.fileProvider.resolve(type);
  }

  /* ------------------------------------------------------------------------ */
  /*  Playback                                                                */
  /* ------------------------------------------------------------------------ */

  private async playAlert(zoneId: number, type: string, media: AlertMediaResource): Promise<void> {
    const isLooped = LOOPED_ALERTS.has(type);
    const useAnnounce = !isLooped;

    // In de oude code werd dit als JSON-string verstuurd
    const payload = useAnnounce
      ? { url: media.url }
      : {
        id: `alerts:${media.relativePath}`,
        name: media.title,
        audiopath: media.url,
        provider: 'alerts',
        type: 0,
        option: 'replace',
      };

    const command = useAnnounce ? 'announce' : 'serviceplay';
    logger.debug(`[AlertsManager] Zone ${zoneId} → ${command} (${media.url})`);

    await zoneRuntime.sendZoneCommand(zoneId, command, payload);

    logger.info(`[AlertsManager] Alert "${type}" started on zone ${zoneId}`);

    if (isLooped) {
      const prevRepeat = zoneRuntime.getZoneState(zoneId)?.plrepeat;
      this.loopState.set(`${zoneId}:${type}`, prevRepeat);
      try {
        await zoneRuntime.sendZoneCommand(zoneId, 'repeat', 'track');
      } catch (err) {
        logger.warn(`[AlertsManager] Failed to enable repeat for zone ${zoneId}: ${String(err)}`);
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Stop handling                                                           */
  /* ------------------------------------------------------------------------ */

  private async stopAlert(zones: number[], type: string): Promise<void> {
    const looped = LOOPED_ALERTS.has(type);

    for (const zoneId of zones) {
      const state = zoneRuntime.getZoneState(zoneId);
      if (!state) {
        continue;
      }

      if (looped) {
        const prev = this.loopState.get(`${zoneId}:${type}`);
        const restore = this.mapRepeatToParam(prev);
        this.loopState.delete(`${zoneId}:${type}`);

        try {
          await zoneRuntime.sendZoneCommand(zoneId, 'repeat', restore);
        } catch (err) {
          logger.warn(`[AlertsManager] Failed to restore repeat for zone ${zoneId}: ${String(err)}`);
        }
      }

      try {
        await zoneRuntime.sendZoneCommand(zoneId, 'pause');
        logger.debug(`[AlertsManager] Zone ${zoneId} paused`);
      } catch (err) {
        logger.warn(`[AlertsManager] Failed to pause zone ${zoneId}: ${String(err)}`);
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Helpers                                                                 */
  /* ------------------------------------------------------------------------ */

  private mapRepeatToParam(value: RepeatMode | undefined): string {
    switch (value) {
      case RepeatMode.Track:
        return 'track';
      case RepeatMode.Queue:
        return 'queue';
      default:
        return 'off';
    }
  }
}

/** Singleton export */
export const alertsManager = new AlertsManager();