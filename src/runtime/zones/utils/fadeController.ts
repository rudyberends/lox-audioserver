import { zoneRuntime } from '@/runtime/zones/zoneRuntime';
import logger from '@/utils/troxorLogger';
import { zoneStateStore } from '../zoneStateStore';

export interface FadeOptions {
  fade?: boolean;
  fadeDurationMs?: number;
}

class FadeController {
  private active = new Map<number, NodeJS.Timeout>();

  /* -------------------------------------------------------------------------- */
  /* PUBLIC API                                                                 */
  /* -------------------------------------------------------------------------- */

  public parseFadeOptions(raw: string): FadeOptions {
    if (!raw) {
      return {};
    }

    const idx = raw.indexOf('q&');
    if (idx === -1) {
      return {};
    }

    const b64 = raw.slice(idx + 2);
    if (!b64) {
      return {};
    }

    let decoded: string;
    try {
      decoded = Buffer.from(b64, 'base64').toString('utf8').trim();
    } catch {
      return {};
    }

    // verwacht:  "fading&fadingTime=120"
    if (!decoded.includes('fading')) {
      return {};
    }

    const match = decoded.match(/fadingTime=(\d+)/);
    const sec = match ? Number(match[1]) : undefined;

    return {
      fade: true,
      fadeDurationMs: sec ? sec * 1000 : undefined,
    };
  }

  /* -------------------------------------------------------------------------- */
  /* FADE ENGINE                                                                 */
  /* -------------------------------------------------------------------------- */

  /**
 * Gradually ramps volume from 0 → target as absolute levels.
 * Uses fixed-time stepping and prevents early fade termination
 * by sending explicit absolute values instead of relative deltas.
 */
  public async fadeIn(zoneId: number, durationMs: number): Promise<void> {
    this.cancel(zoneId);

    const zoneState = zoneStateStore.get(zoneId);
    if (!zoneState) {
      logger.warn(`[FadeController] Zone ${zoneId} not found`);
      return;
    }

    const zone = (zoneRuntime as any).zones.get(zoneId);
    const volumes = zone?.volumes ?? {};

    // Fade targets the buzzer volume, fallback to default.
    const target = Math.max(
      0,
      Math.min(100, Number(volumes.buzzer ?? volumes.default ?? 50)),
    );

    const intervalMs = 2000; // fixed tick
    const steps = Math.max(1, Math.round(durationMs / intervalMs));
    const floatDelta = target / steps;

    let current = 0;

    logger.info(`[FadeController] Fade in zone ${zoneId}: target=${target}, steps=${steps}, delta=${floatDelta.toFixed(2)}`);

    // Ensure we start muted
    try {
      await zoneRuntime.sendZoneCommand(zoneId, 'volume', { absolute: 0 });
    } catch { /* empty */ }

    let step = 0;

    const interval = setInterval(async () => {
      step++;

      current = Math.min(target, floatDelta * step);

      try {
        await zoneRuntime.sendZoneCommand(zoneId, 'volume', {
          absolute: Math.round(current),
        });
      } catch (err) {
        logger.warn(`[FadeController] Failed to set fade step: ${String(err)}`);
      }

      if (step >= steps) {
        clearInterval(interval);
        this.active.delete(zoneId);
        logger.debug(`[FadeController] Fade complete for zone ${zoneId}`);
      }
    }, intervalMs);

    this.active.set(zoneId, interval);
  }

  /** Stop fade */
  public cancel(zoneId: number): void {
    const timer = this.active.get(zoneId);
    if (!timer) {
      return;
    }

    clearInterval(timer);
    this.active.delete(zoneId);

    logger.debug(`[FadeController] Fade canceled for zone ${zoneId}`);
  }
}

export const fadeController = new FadeController();