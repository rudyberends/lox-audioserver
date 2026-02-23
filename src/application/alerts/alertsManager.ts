import { createLogger } from '@/shared/logging/logger';
import path from 'node:path';
import { FileAlertProvider } from '@/application/alerts/fileAlertProvider';
import { GoogleTtsProvider } from '@/application/alerts/googleTtsProvider';
import type { AlertAction, AlertActionResult, AlertMediaResource } from '@/application/alerts/types';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { ZoneVolumesConfig } from '@/domain/config/types';
import type { ConfigPort } from '@/ports/ConfigPort';

const DEFAULT_ALERT_VOLUME = 30;
const MAX_ALERT_PRE_DELAY_MS = 10_000;
const MIN_VOLUME = 0;
const MAX_VOLUME = 100;
const CUSTOM_URL_PREFIX = 'custom_url/';

export class AlertsManager {
  private readonly log = createLogger('Alerts', 'Manager');
  private readonly fileProvider = new FileAlertProvider();
  private readonly ttsProvider = new GoogleTtsProvider();
  private zoneManager: ZoneManagerFacade | null = null;
  private configPort: ConfigPort | null = null;

  public initOnce(deps: { zoneManager: ZoneManagerFacade; configPort: ConfigPort }): void {
    if (this.zoneManager) {
      throw new Error('alerts manager already initialized');
    }
    if (!deps.zoneManager) {
      throw new Error('alerts manager missing zone manager');
    }
    if (!deps.configPort) {
      throw new Error('alerts manager missing config port');
    }
    this.zoneManager = deps.zoneManager;
    this.configPort = deps.configPort;
  }

  private get zones(): ZoneManagerFacade {
    if (!this.zoneManager) {
      throw new Error('zone manager not configured');
    }
    return this.zoneManager;
  }

  private get config(): ConfigPort {
    if (!this.configPort) {
      throw new Error('config port not configured');
    }
    return this.configPort;
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
    const effectiveMedia = this.applyAlertPreDelay(media);

    await Promise.all(
      zones.map(async (zoneId) => {
        const volume = this.resolveAlertVolume(zoneId, normalizedType);
        await this.zones.startAlert(zoneId, normalizedType, effectiveMedia, volume);
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
    const effectiveMedia = this.applyAlertPreDelay(media);

    await Promise.all(
      zones.map(async (zoneId) => {
        const volume = this.resolveAlertVolume(zoneId, 'uploaded');
        await this.zones.startAlert(zoneId, 'uploaded', effectiveMedia, volume);
      }),
    );

    return { success: true, type: 'uploaded', action: 'on' };
  }

  public async handlePlayEventFile(
    relativePath: string,
    targets: Array<{ zoneId: number; volume?: number }>,
  ): Promise<AlertActionResult> {
    const normalizedTargets = targets.filter((entry) => Number.isFinite(entry.zoneId) && entry.zoneId > 0);
    if (!relativePath || !normalizedTargets.length) {
      return { success: false, type: 'playeventfile', action: 'on', reason: 'invalid-input' };
    }

    this.log.info('ON playeventfile alert', {
      relativePath,
      targets: normalizedTargets,
    });
    const media = await this.resolvePlayEventMedia(relativePath);
    if (!media) {
      return { success: false, type: 'playeventfile', action: 'on', reason: 'media-unavailable' };
    }
    const effectiveMedia = this.applyAlertPreDelay(media);

    await Promise.all(
      normalizedTargets.map(async ({ zoneId, volume }) => {
        const resolvedVolume = this.resolveAlertVolume(zoneId, 'playeventfile', volume);
        await this.zones.startAlert(zoneId, 'playeventfile', effectiveMedia, resolvedVolume);
      }),
    );

    return { success: true, type: 'playeventfile', action: 'on' };
  }

  private async resolvePlayEventMedia(input: string): Promise<AlertMediaResource | undefined> {
    const customUrl = parseCustomEventUrl(input);
    if (customUrl) {
      return {
        title: inferCustomUrlTitle(customUrl),
        relativePath: `${CUSTOM_URL_PREFIX}${customUrl}`,
        url: customUrl,
      };
    }
    const filename = path.basename(input) || input;
    return this.fileProvider.resolveRelative(input, filename);
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

  private resolveAlertVolume(zoneId: number, type: string, override?: number): number {
    const volumes = this.zones.getZoneVolumes(zoneId);
    const maxVolume =
      typeof volumes?.maxVolume === 'number' && volumes.maxVolume > 0 ? volumes.maxVolume : MAX_VOLUME;
    if (typeof override === 'number' && Number.isFinite(override)) {
      return Math.min(Math.max(Math.round(override), MIN_VOLUME), maxVolume);
    }
    if (!volumes) {
      return DEFAULT_ALERT_VOLUME;
    }
    const key = mapAlertTypeToVolumeKey(type);
    const requested = (volumes as any)[key] ?? volumes.default ?? DEFAULT_ALERT_VOLUME;
    const clamped = Math.min(
      Math.max(Number(requested) || DEFAULT_ALERT_VOLUME, MIN_VOLUME),
      maxVolume,
    );
    return clamped;
  }

  private applyAlertPreDelay(media: AlertMediaResource): AlertMediaResource {
    const preDelayMs = this.resolveAlertPreDelayMs();
    if (preDelayMs <= 0) {
      return media;
    }
    const delayedUrl = appendPreDelayToAlertUrl(media.url, preDelayMs);
    if (delayedUrl === media.url) {
      return media;
    }
    return { ...media, url: delayedUrl };
  }

  private resolveAlertPreDelayMs(): number {
    const raw = this.config.getConfig()?.system?.audioserver?.alertPreDelayMs;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return 0;
    }
    return Math.min(MAX_ALERT_PRE_DELAY_MS, Math.max(0, Math.round(parsed)));
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

function appendPreDelayToAlertUrl(url: string, preDelayMs: number): string {
  if (!/^alerts(?:-loop)?:\/\//i.test(url)) {
    return url;
  }
  const [base, rawQuery = ''] = url.split('?', 2);
  const params = new URLSearchParams(rawQuery);
  params.set('predelay', String(preDelayMs));
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

function parseCustomEventUrl(input: string): string | null {
  const raw = String(input ?? '').trim();
  if (!raw.toLowerCase().startsWith(CUSTOM_URL_PREFIX)) {
    return null;
  }
  const candidate = raw.slice(CUSTOM_URL_PREFIX.length).trim();
  if (!candidate) {
    return null;
  }
  const decoded = safeDecodeURIComponent(candidate);
  const url = tryParseHttpUrl(decoded) ?? tryParseHttpUrl(candidate);
  return url?.toString() ?? null;
}

function tryParseHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed;
    }
  } catch {
    // ignore invalid urls
  }
  return null;
}

function inferCustomUrlTitle(url: string): string {
  try {
    const parsed = new URL(url);
    const segment = path.posix.basename(parsed.pathname || '').trim();
    if (segment) {
      return safeDecodeURIComponent(segment);
    }
    return parsed.host || 'custom_url';
  } catch {
    return 'custom_url';
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export const alertsManager = new AlertsManager();
