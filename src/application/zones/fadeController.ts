import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';

export interface FadeOptions {
  fade?: boolean;
  fadeDurationMs?: number;
}

class FadeController {
  private readonly active = new Map<number, NodeJS.Timeout>();
  private zoneManager: ZoneManagerFacade | null = null;

  public initOnce(deps: { zoneManager: ZoneManagerFacade }): void {
    if (this.zoneManager) {
      throw new Error('fade controller already initialized');
    }
    if (!deps.zoneManager) {
      throw new Error('fade controller missing zone manager');
    }
    this.zoneManager = deps.zoneManager;
  }

  private get zones(): ZoneManagerFacade {
    if (!this.zoneManager) {
      throw new Error('zone manager not configured');
    }
    return this.zoneManager;
  }

  public parseFadeOptions(raw: string): FadeOptions {
    if (!raw) {
      return {};
    }
    const marker = '?q&';
    const idx = raw.indexOf(marker);
    if (idx === -1) {
      return {};
    }
    const b64 = raw.slice(idx + marker.length);
    if (!b64) {
      return {};
    }
    let decoded: string;
    try {
      decoded = Buffer.from(b64, 'base64').toString('utf8').trim();
    } catch {
      return {};
    }
    if (!decoded.includes('fading')) {
      return {};
    }
    const match = decoded.match(/fadingTime=(\d+)/);
    const sec = match ? Number(match[1]) : undefined;
    return {
      fade: true,
      fadeDurationMs: sec && Number.isFinite(sec) ? Math.max(0, sec * 1000) : undefined,
    };
  }

  public async fadeIn(zoneId: number, durationMs: number): Promise<void> {
    this.cancel(zoneId);
    const volumes = this.zones.getZoneVolumes(zoneId) as
      | { buzzer?: number; default?: number }
      | undefined;
    const target = Math.max(
      0,
      Math.min(100, Number(volumes?.buzzer ?? volumes?.default ?? 50)),
    );
    const intervalMs = 2000;
    const steps = Math.max(1, Math.round(durationMs / intervalMs));
    const floatDelta = target / steps;
    let step = 0;

    // Start muted before ramping up.
    this.zones.handleCommand(zoneId, 'volume_set', '0');

    const interval = setInterval(() => {
      step += 1;
      const next = Math.min(target, Math.round(floatDelta * step));
      this.zones.handleCommand(zoneId, 'volume_set', String(next));
      if (step >= steps) {
        clearInterval(interval);
        this.active.delete(zoneId);
      }
    }, intervalMs);

    this.active.set(zoneId, interval);
  }

  public cancel(zoneId: number): void {
    const timer = this.active.get(zoneId);
    if (!timer) return;
    clearInterval(timer);
    this.active.delete(zoneId);
  }
}

export const fadeController = new FadeController();
