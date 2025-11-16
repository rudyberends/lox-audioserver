import logger from '@/utils/troxorLogger';
import { zoneRuntime } from '@/runtime/zones/zoneRuntime';
import type { AlertMediaResource } from '@/model/local/alerts/types/AlertTypes';
import { FileAlertProvider } from '@/model/local/alerts/alerts/fileAlertsProvider';
import { GoogleTtsProvider } from '@/model/local/alerts/tts/googleTtsProvder';
import { AlertController } from '@/model/local/alerts/AlertController';
import { AlertPlaybackEngine } from '@/model/local/alerts/AlertPlaybackEngine';

/**
 * -----------------------------------------------------------------------------
 * AlertsManager
 * -----------------------------------------------------------------------------
 * High-level orchestration of alert lifecycle:
 *  - Resolves alert media (TTS or file)
 *  - Determines target zones and per-zone volume
 *  - Delegates lifecycle control to AlertController
 *  - Automatically handles per-zone auto-stop for one-shot alerts (TTS)
 *
 * This class is the public entry point for grouped alerts coming from Loxone.
 * -----------------------------------------------------------------------------
 */
export class AlertsManager {
  private readonly controller = new AlertController(new AlertPlaybackEngine());
  private readonly fileProvider = new FileAlertProvider();
  private readonly ttsProvider = new GoogleTtsProvider();

  /**
   * Handles ON/OFF alert commands for a leader zone, optionally targeting a group.
   */
  public async handleGroupedAlert(
    leaderId: number,
    type: string,
    action: 'on' | 'off',
    targetZones?: number[],
    ttsText?: string,
    ttsLang?: string,
  ): Promise<{ success: boolean; type: string; action: string }> {
    const zones = targetZones?.length ? targetZones : [leaderId];
    logger.info(`[AlertsManager] ${action.toUpperCase()} alert "${type}" zones=${JSON.stringify(zones)}`);

    if (action === 'off') {
      await this.controller.alertStop(zones, type);
      return { success: true, type, action };
    }

    // Resolve alert media (TTS or static file)
    const media = await this.resolveMedia(type, ttsText, ttsLang);
    if (!media) {
      logger.warn(`[AlertsManager] No media for alert type "${type}"`);
      return { success: false, type, action };
    }

    // Start alert — controller handles full per-zone lifecycle
    await this.controller.alertStart(
      zones,
      type,
      media,
      (zoneId) => this.resolveAlertVolume(zoneId, type),
    );

    return { success: true, type, action };
  }

  /**
   * Handles one-shot alerts from uploaded audio files.
   */
  public async handleUploadedAlert(
    filename: string,
    targetZones: number[],
  ): Promise<{ success: boolean; type: string; action: string }> {
    const zones = targetZones.length ? targetZones : [];
    logger.info(`[AlertsManager] ON uploaded alert "${filename}" zones=${JSON.stringify(zones)}`);

    if (zones.length === 0) {
      return { success: false, type: 'uploaded', action: 'on' };
    }

    const media = await this.fileProvider.resolveUploaded(filename);
    if (!media) {
      logger.warn(`[AlertsManager] Uploaded media not found for "${filename}"`);
      return { success: false, type: 'uploaded', action: 'on' };
    }

    await this.controller.alertStart(
      zones,
      'uploaded',
      media,
      (zoneId) => this.resolveAlertVolume(zoneId, 'uploaded'),
    );

    return { success: true, type: 'uploaded', action: 'on' };
  }

  /* --------------------------------------------------------------------------
   * Media resolution                                                          *
   * ------------------------------------------------------------------------ */

  private async resolveMedia(
    type: string,
    ttsText?: string,
    ttsLang?: string,
  ): Promise<AlertMediaResource | undefined> {
    if (type === 'tts') {
      if (!ttsText) {
        return undefined;
      }
      return this.ttsProvider.generate(ttsText, ttsLang ?? 'en');
    }
    return this.fileProvider.resolve(type);
  }

  /* --------------------------------------------------------------------------
   * Volume resolution per zone                                                *
   * ------------------------------------------------------------------------ */

  /**
   * Computes the final alert volume for a zone based on the configured profile.
   * Uses ZoneRuntime as the authoritative source for event volumes.
   */
  private resolveAlertVolume(zoneId: number, type: string): number {
    const vols = zoneRuntime.getZoneVolumeConfig(zoneId);
    if (!vols) {
      return 30;
    }

    const key = typeToVolumeKey(type);

    return (
      (vols as any)[key] ??
      vols.default ??
      30
    );
  }
}

/**
 * Mapping function from alert type → volume config key.
 */
function typeToVolumeKey(type: string): string {
  switch (type) {
    case 'alarm':
      return 'alarm';
    case 'fire':
    case 'firealarm':
      return 'fire';
    case 'bell':
      return 'bell';
    case 'buzzer':
      return 'buzzer';
    case 'tts':
      return 'tts';
    default:
      return 'default';
  }
}

/** Singleton export */
export const alertsManager = new AlertsManager();