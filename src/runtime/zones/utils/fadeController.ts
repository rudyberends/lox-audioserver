import { zoneRuntime } from '@/runtime/zones/zoneRuntime';
import logger from '@/utils/troxorLogger';
import { zoneStateStore } from '../zoneStateStore';

export interface FadeOptions {
  fade?: boolean;
  fadeDurationMs?: number;
}

class FadeController {
  private active = new Map<number, NodeJS.Timeout>();

  /**
   * Gradually raises volume from 0 → zone.volumes.buzzer (or default)
   * over the given duration, in smooth 2-second increments.
   */
  public async fadeIn(zoneId: number, durationMs: number): Promise<void> {
    this.cancel(zoneId); // cancel existing fade

    const zoneState = zoneStateStore.get(zoneId);

    if (!zoneState) {
      logger.warn(`[FadeController] Zone ${zoneId} not found in state store`);
      return;
    }

    const volumes = (zoneRuntime as any).zones.get(zoneId)?.volumes ?? {};
    const targetVolume = Number(volumes?.buzzer ?? volumes?.default ?? 50);
    const steps = Math.max(1, Math.floor(durationMs / 2000)); // every 2s
    const stepSize = targetVolume / steps;
    let currentVolume = 0;

    logger.debug(
      `[FadeController] Fading in zone ${zoneId}: 0 → ${targetVolume} over ${durationMs}ms (${steps} steps of ${stepSize.toFixed(2)})`,
    );

    // Ensure we start muted
    try {
      await zoneRuntime.sendZoneCommand(zoneId, 'volume', String(-999)); // mute before fade
      zoneStateStore.patch(zoneId, { volume: 0 });
    } catch (err) {
      logger.warn(`[FadeController] Failed to set initial volume 0 for zone ${zoneId}: ${String(err)}`);
    }

    let step = 0;
    const interval = setInterval(async () => {
      step++;
      currentVolume = Math.min(targetVolume, currentVolume + stepSize);

      try {
        const currentState = zoneStateStore.get(zoneId);
        const delta = currentVolume - (currentState?.volume ?? 0);
        await zoneRuntime.sendZoneCommand(zoneId, 'volume', String(delta));
      } catch (err) {
        logger.warn(`[FadeController] Volume step failed for zone ${zoneId}: ${String(err)}`);
      }

      if (step >= steps || currentVolume >= targetVolume) {
        this.cancel(zoneId);
        logger.debug(`[FadeController] Fade complete for zone ${zoneId}`);
      }
    }, 2000);

    this.active.set(zoneId, interval);
  }

  /** Cancels an ongoing fade */
  public cancel(zoneId: number): void {
    const existing = this.active.get(zoneId);
    if (existing) {
      clearInterval(existing);
      this.active.delete(zoneId);
      logger.debug(`[FadeController] Cancelled fade for zone ${zoneId}`);
    }
  }
}

export function parseFadeOptions(raw: string): FadeOptions {
  if (!raw) {
    return {};
  }
  const decoded = decodeURIComponentSafe(raw).trim();
  if (!decoded.startsWith('?')) {
    return {};
  }

  let query = decoded.slice(1);
  if (!query) {
    return {};
  }

  if (query.startsWith('q&')) {
    const base64Payload = query.slice(2);
    try {
      const unpacked = Buffer.from(base64Payload, 'base64').toString('utf8');
      query = unpacked.startsWith('?') ? unpacked.slice(1) : unpacked;
    } catch {
      return {};
    }
  }

  if (!query) {
    return {};
  }

  const params = new URLSearchParams(query);
  const fadingFlag =
    params.has('fading') ||
    params.get('fading') === '1' ||
    params.has('fade') ||
    params.get('fade') === '1' ||
    params.get('fade')?.toLowerCase() === 'true';

  const fadeTimeParam =
    params.get('fadingTime') ?? params.get('fadeTime') ?? params.get('fadeDuration');

  let fadeDurationMs: number | undefined;
  if (fadeTimeParam) {
    const numeric = Number(fadeTimeParam);
    if (Number.isFinite(numeric) && numeric >= 0) {
      fadeDurationMs = Math.round(numeric * 1000);
    }
  }

  if (fadingFlag || fadeDurationMs !== undefined) {
    return {
      fade: true,
      fadeDurationMs,
    };
  }

  return {};
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export const fadeController = new FadeController();