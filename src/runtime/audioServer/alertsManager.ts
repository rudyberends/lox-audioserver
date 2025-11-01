import logger from '@/utils/troxorLogger';
import { zoneRuntime } from '@/runtime/zones/zoneRuntime';
import {
  getGroupByLeader,
  upsertGroup,
  removeGroupByLeader,
} from '@/runtime/groups/groupTracker';
import { groupRuntime } from '@/runtime/groups/groupRuntime';
import type { AlertMediaResource } from '@/model/local/alerts/types';
import { FileAlertProvider } from '@/model/local/alerts/alerts/fileAlertsProvider';
import { GoogleTtsProvider } from '@/model/local/alerts/tts/googleTtsProvder';

const LOOPED_ALERTS = new Set(['alarm', 'firealarm', 'buzzer']);
const TEMP_GROUP_DURATION_MS = 10_000; // auto-cleanup for short alerts

/**
 * -----------------------------------------------------------------------------
 * AlertsManager
 * -----------------------------------------------------------------------------
 * Resolves alert media (File/TTS), handles optional grouping, and delegates
 * playback to ZoneRuntime. Temporary groups are automatically removed for
 * non-looped alerts (e.g. TTS, bell), but persist for alarms until stopped.
 * -----------------------------------------------------------------------------
 */
export class AlertsManager {
  private readonly fileProvider = new FileAlertProvider();
  private readonly ttsProvider = new GoogleTtsProvider();

  /**
   * Handles a grouped alert request from the Loxone command router.
   *
   * @param leaderId   Zone ID of the leader (first zone in list)
   * @param type       Alert type (e.g. "alarm", "tts", "buzzer")
   * @param action     "start" or "off"
   * @param targetZones Optional list of target zones
   * @param ttsText    Optional TTS message text
   * @param ttsLang    Optional TTS language code
   */
  public async handleGroupedAlert(
    leaderId: number,
    type: string,
    action: 'on' | 'off',
    targetZones?: number[],
    ttsText?: string,
    ttsLang?: string,
  ): Promise<{ success: boolean; type: string; action: string; reason?: string }> {
    logger.info(`[AlertsManager] ${action.toUpperCase()} alert "${type}" for leader ${leaderId}`);

    const zones = targetZones?.length ? targetZones : [14];

    // 🔹 Stop alert
    if (action === 'off') {
      await this.stopAlert(zones, type);
      return { success: true, type, action };
    }

    // 🔹 Resolve media
    const media = await this.resolveMedia(type, ttsText, ttsLang);
    if (!media) {
      logger.warn(`[AlertsManager] No media found for alert type "${type}"`);
      return { success: false, type, action, reason: 'media-unavailable' };
    }

    const multiZone = zones.length > 1;
    const leader = zones[0];

    // 🔹 Create temporary group if multiple zones
    if (multiZone) {
      upsertGroup({
        leader,
        members: zones,
        externalId: `alert-${leader}`,
        backend: 'alerts',
        source: 'manual',
      });
      groupRuntime.broadcastGroupState();
      logger.debug(`[AlertsManager] Temporary alert group created (${zones.length} zones)`);

      // 🕐 Wait briefly for group registration to propagate before playback
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    try {
      await this.playAlert(leader, type, media);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[AlertsManager] Failed to start alert "${type}": ${msg}`);

      // Clean up group if playback fails
      if (multiZone) {
        removeGroupByLeader(leader);
        groupRuntime.broadcastGroupState();
      }
      return { success: false, type, action, reason: msg };
    }

    // 🔹 Auto-remove group only for short alerts
    if (multiZone && this.shouldAutoRemoveGroup(type)) {
      setTimeout(() => {
        removeGroupByLeader(leader);
        groupRuntime.broadcastGroupState();
        logger.debug(`[AlertsManager] Temporary alert group ${leader} removed`);
      }, TEMP_GROUP_DURATION_MS);
    }

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

    const payload = ['alerts', media.url]; // consistent with serviceplay signature

    logger.debug(
      `[AlertsManager] Using ${useAnnounce ? 'announce' : 'serviceplay'} (looped=${isLooped}) → ${media.url}`,
    );

    await zoneRuntime.sendZoneCommand(
      zoneId,
      useAnnounce ? 'announce' : 'serviceplay',
      payload,
    );

    logger.info(
      `[AlertsManager] Alert "${type}" started via ${useAnnounce ? 'announce' : 'serviceplay'} on zone ${zoneId}`,
    );
  }

  /* ------------------------------------------------------------------------ */
  /*  Stop handling                                                           */
  /* ------------------------------------------------------------------------ */

  private async stopAlert(zones: number[], type: string): Promise<void> {
    logger.debug(`[AlertsManager] Stopping alert "${type}" for ${zones.length} zone(s)`);

    const leader = zones[0];
    try {
      await zoneRuntime.sendZoneCommand(leader, 'pause');
      logger.info(`[AlertsManager] Leader zone ${leader} paused for alert "${type}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[AlertsManager] Failed to pause leader zone ${leader}: ${msg}`);
    }

    // Remove group if one exists
    const existingGroup = getGroupByLeader(leader);
    if (existingGroup) {
      removeGroupByLeader(leader);
      groupRuntime.broadcastGroupState();
      logger.debug(`[AlertsManager] Group for alert "${type}" removed after stop`);
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Helpers                                                                 */
  /* ------------------------------------------------------------------------ */

  /** Determines whether a group should auto-remove after a fixed timeout. */
  private shouldAutoRemoveGroup(type: string): boolean {
    // alarms/firealarms/buzzers are looping until explicit stop
    return !LOOPED_ALERTS.has(type);
  }
}

/** Singleton export */
export const alertsManager = new AlertsManager();