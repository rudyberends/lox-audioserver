import { createLogger } from '@/shared/logging/logger';
import { FileAlertProvider } from '@/application/alerts/fileAlertProvider';
import { GoogleTtsProvider } from '@/application/alerts/googleTtsProvider';
import type { AlertAction, AlertActionResult, AlertMediaResource } from '@/application/alerts/types';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { ZoneVolumesConfig } from '@/domain/config/types';

const DEFAULT_ALERT_VOLUME = 30;

export class AlertsManager {
  private readonly log = createLogger('Alerts', 'Manager');
  private readonly fileProvider = new FileAlertProvider();
  private readonly ttsProvider = new GoogleTtsProvider();
  private zoneManager: ZoneManagerFacade | null = null;

  public initOnce(deps: { zoneManager: ZoneManagerFacade }): void {
    if (this.zoneManager) {
      throw new Error('alerts manager already initialized');
    }
    if (!deps.zoneManager) {
      throw new Error('alerts manager missing zone manager');
    }
    this.zoneManager = deps.zoneManager;
  }

  private get zones(): ZoneManagerFacade {
    if (!this.zoneManager) {
      throw new Error('zone manager not configured');
    }
    return this.zoneManager;
  }

  public async handleGroupedAlert(
    leaderId: number,
    type: string,
    action: AlertAction,
    targetZones?: number[],
    ttsText?: string,
    ttsLang?: string,
  ): Promise<AlertActionResult> {
    const zones = targetZones?.length ? targetZones : leaderId ? [leaderId] : [];
    const normalizedType = type.toLowerCase();

    if (!zones.length) {
      return { success: false, type: normalizedType, action, reason: 'invalid-zones' };
    }

    this.log.info(`${action.toUpperCase()} alert`, { type: normalizedType, zones });

    if (action === 'off') {
      await Promise.all(zones.map((zoneId) => this.zones.stopAlert(zoneId)));
      return { success: true, type: normalizedType, action };
    }

    const media = await this.resolveMedia(normalizedType, ttsText, ttsLang);
    if (!media) {
      this.log.warn('no media resolved for alert', { type: normalizedType });
      return { success: false, type: normalizedType, action, reason: 'media-unavailable' };
    }

    await Promise.all(
      zones.map(async (zoneId) => {
        const volume = this.resolveAlertVolume(zoneId, normalizedType);
        await this.zones.startAlert(zoneId, normalizedType, media, volume);
      }),
    );

    return { success: true, type: normalizedType, action };
  }

  public async handleUploadedAlert(
    filename: string,
    targetZones: number[],
  ): Promise<AlertActionResult> {
    const zones = targetZones?.length ? targetZones : [];
    if (!filename || !zones.length) {
      return { success: false, type: 'uploaded', action: 'on', reason: 'invalid-input' };
    }
    this.log.info('ON uploaded alert', { filename, zones });

    const media = await this.fileProvider.resolveUploaded(filename);
    if (!media) {
      return { success: false, type: 'uploaded', action: 'on', reason: 'media-unavailable' };
    }

    await Promise.all(
      zones.map(async (zoneId) => {
        const volume = this.resolveAlertVolume(zoneId, 'uploaded');
        await this.zones.startAlert(zoneId, 'uploaded', media, volume);
      }),
    );

    return { success: true, type: 'uploaded', action: 'on' };
  }

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

  private resolveAlertVolume(zoneId: number, type: string): number {
    const volumes = this.zones.getZoneVolumes(zoneId);
    if (!volumes) {
      return DEFAULT_ALERT_VOLUME;
    }
    const key = mapAlertTypeToVolumeKey(type);
    const requested = (volumes as any)[key] ?? volumes.default ?? DEFAULT_ALERT_VOLUME;
    const maxVolume =
      typeof volumes.maxVolume === 'number' && volumes.maxVolume > 0 ? volumes.maxVolume : 100;
    const clamped = Math.min(Math.max(Number(requested) || DEFAULT_ALERT_VOLUME, 0), maxVolume);
    return clamped;
  }
}

function mapAlertTypeToVolumeKey(type: string): keyof ZoneVolumesConfig | 'default' {
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

export const alertsManager = new AlertsManager();
