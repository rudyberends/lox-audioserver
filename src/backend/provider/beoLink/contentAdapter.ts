import axios from 'axios';
import logger from '../../../utils/troxorlogger';
import type { ZoneEntry } from '../../zone/zonemanager';
import { getZoneById } from '../../zone/zonemanager';
import {
  registerZoneContentAdapter,
  ZoneContentPlaybackAdapter,
  ZoneContentCommand,
  ZoneContentFactoryOptions,
} from '../../zone/capabilities';

const SUPPORTED_COMMANDS: ZoneContentCommand[] = ['serviceplay'];

class BeolinkContentAdapter implements ZoneContentPlaybackAdapter {
  constructor(private readonly options: ZoneContentFactoryOptions, private readonly baseUrl: string) {}

  handles(command: string): boolean {
    return SUPPORTED_COMMANDS.includes(command as ZoneContentCommand);
  }

  async execute(command: ZoneContentCommand, payload: unknown): Promise<boolean> {
    switch (command) {
      case 'serviceplay':
        return this.handleServicePlay(payload);
      default:
        return false;
    }
  }

  async cleanup(): Promise<void> {
    // No persistent resources to release.
  }

  private async handleServicePlay(rawPayload: unknown): Promise<boolean> {
    const { stationId, payload } = normalizeServicePlayPayload(rawPayload);
    if (!stationId) {
      logger.warn(`[BeoLink][ContentAdapter][Zone ${this.options.zoneId}] serviceplay missing station identifier`);
      return true;
    }

    const url = `${this.baseUrl}/BeoZone/Zone/PlayQueue?instantplay`;
    const requestPayload = buildPlayQueuePayload(stationId, payload);

    try {
      await axios.request({
        method: 'POST',
        url,
        data: requestPayload,
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000,
      });
      logger.info(`[BeoLink][ContentAdapter][Zone ${this.options.zoneId}] serviceplay queued station ${stationId}`);
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.response?.statusText || error.message
        : (error as Error).message;
      logger.warn(`[BeoLink][ContentAdapter][Zone ${this.options.zoneId}] serviceplay failed for ${stationId}: ${message}`);
    }

    return true;
  }
}

registerZoneContentAdapter({
  key: 'beolink',
  label: 'BeoLink Player',
  defaultBackends: ['BackendBeolink'],
  providers: ['BeolinkProvider'],
  factory: (options) => {
    if (options.backendId !== 'BackendBeolink') return undefined;
    const ip = options.zoneConfig.ip?.trim();
    if (!ip) {
      logger.warn(`[BeoLink][ContentAdapter][Zone ${options.zoneId}] Missing backend IP; content playback disabled.`);
      return undefined;
    }
    const baseUrl = `http://${ip}:8080`;
    return new BeolinkContentAdapter(
      {
        ...options,
        getZoneOrWarn: () => getZoneById(options.zoneId) as ZoneEntry | undefined,
      },
      baseUrl,
    );
  },
});

function normalizeServicePlayPayload(param: unknown): {
  stationId?: string;
  payload?: Record<string, any>;
} {
  const payload = coercePayload(param);
  const stationId =
    extractStationId(payload) ??
    (typeof param === 'string' ? sanitizeStationId(param) : undefined);

  return {
    stationId,
    payload: payload ?? (stationId ? { stationId } : undefined),
  };
}

function buildPlayQueuePayload(stationId: string, payload?: Record<string, any>) {
  const behaviour = typeof payload?.behaviour === 'string' && payload.behaviour.trim().length > 0
    ? payload.behaviour.trim()
    : 'planned';

  return {
    behaviour,
    playQueueItem: {
      primaryExperience: 'Radio',
      station: {
        tuneIn: {
          stationId,
        },
      },
      title: payload?.title || payload?.name || stationId,
      image: payload?.image || payload?.coverUrl || '',
    },
  };
}

function coercePayload(param: unknown): Record<string, any> | undefined {
  if (param === undefined || param === null) return undefined;

  if (typeof param === 'string') {
    try {
      return JSON.parse(param);
    } catch {
      return { stationId: param };
    }
  }

  if (Array.isArray(param) && param.length > 0) {
    const [first] = param;
    if (typeof first === 'object' && first !== null) {
      return first as Record<string, any>;
    }
    if (typeof first === 'string') {
      return coercePayload(first);
    }
  }

  if (typeof param === 'object') {
    return param as Record<string, any>;
  }

  if (typeof param === 'number' || typeof param === 'boolean') {
    return { stationId: String(param) };
  }

  return undefined;
}

function extractStationId(payload?: Record<string, any>): string | undefined {
  if (!payload) return undefined;

  const directKeys = ['stationId', 'id', 'audiopath', 'station'];
  for (const key of directKeys) {
    const value = payload[key];
    const sanitized = sanitizeStationId(value);
    if (sanitized) return sanitized;
  }

  const nested =
    payload?.playQueueItem?.station?.tuneIn?.stationId ??
    payload?.station?.tuneIn?.stationId ??
    payload?.tuneIn?.stationId;
  const nestedId = sanitizeStationId(nested);
  if (nestedId) return nestedId;

  return undefined;
}

function sanitizeStationId(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    const withoutQuery = trimmed.split('?')[0] ?? trimmed;
    const pathSegments = withoutQuery.split('/').filter((segment) => segment.length > 0);
    const lastPathSegment = pathSegments.length > 0 ? pathSegments[pathSegments.length - 1] : withoutQuery;
    const colonSegments = lastPathSegment.split(':').filter((segment) => segment.length > 0);
    const candidate =
      colonSegments.length > 0 ? colonSegments[colonSegments.length - 1] : lastPathSegment;
    const normalized = candidate.trim();
    return normalized.length > 0 ? normalized : undefined;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return undefined;
}
