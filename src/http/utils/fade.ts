import { Buffer } from 'buffer';
import logger from '../../utils/troxorlogger';
export interface FadeOptions {
  fade?: boolean;
  fadeDurationMs?: number;
}

export interface FadeController {
  abort: boolean;
  timer?: NodeJS.Timeout;
}

export interface FadeSnapshot {
  originalVolume: number;
  fadeDurationMs: number;
}

export const DEFAULT_FADE_DURATION_MS = 3_000;
export const MIN_FADE_STEP_MS = 200;

export function parseFadeOptions(raw: string): FadeOptions {
  if (!raw) return {};
  const decoded = decodeURIComponentSafe(raw).trim();
  if (!decoded.startsWith('?')) {
    return {};
  }

  let query = decoded.slice(1);
  if (!query) return {};

  if (query.startsWith('q&')) {
    const base64Payload = query.slice(2);
    try {
      const unpacked = Buffer.from(base64Payload, 'base64').toString('utf8');
      query = unpacked.startsWith('?') ? unpacked.slice(1) : unpacked;
    } catch {
      return {};
    }
  }

  if (!query) return {};

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

export function clampFadeDuration(value: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.max(MIN_FADE_STEP_MS, Math.round(numeric));
}

export function clampVolume(value: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.min(100, Math.max(0, numeric));
}

export function cancelFade(key: string, controllers: Map<string, FadeController>): void {
  const controller = controllers.get(key);
  if (!controller) return;
  controller.abort = true;
  if (controller.timer) {
    clearTimeout(controller.timer);
  }
  controllers.delete(key);
}

export function scheduleFade(
  zoneId: number,
  key: string,
  controllers: Map<string, FadeController>,
  fromVolume: number,
  toVolume: number,
  durationMs: number,
  onStep: ((value: number) => Promise<void>) | null,
  onComplete?: () => Promise<void> | void,
): void {
  cancelFade(key, controllers);

  const start = clampVolume(fromVolume);
  const target = clampVolume(toVolume);
  const duration = clampFadeDuration(durationMs);

  const applyVolume = (value: number) =>
    onStep ? onStep(clampVolume(value)) : Promise.resolve();

  // Ensure we start from the requested volume immediately (helps when backends reset volume on play).
  applyVolume(start).catch((error) => logFadeWarning(zoneId, 'set volume', error));

  if (duration <= 0 || start === target) {
    applyVolume(target)
      .catch((error) => logFadeWarning(zoneId, 'set volume', error))
      .finally(() => {
        if (onComplete) {
          Promise.resolve(onComplete()).catch((error) =>
            logFadeWarning(zoneId, 'fade completion handler', error),
          );
        }
      });
    return;
  }

  const controller: FadeController = { abort: false };
  controllers.set(key, controller);

  const steps = Math.max(1, Math.round(duration / MIN_FADE_STEP_MS));
  const stepDuration = Math.max(50, Math.round(duration / steps));
  let currentStep = 0;

  const runStep = () => {
    if (controller.abort) {
      controllers.delete(key);
      return;
    }

    currentStep += 1;
    const progress = currentStep / steps;
    const nextValue = clampVolume(start + (target - start) * progress);

    applyVolume(nextValue).catch((error) =>
      logFadeWarning(zoneId, 'volume adjustment', error),
    );

    if (controller.abort) {
      controllers.delete(key);
      return;
    }

    if (currentStep >= steps) {
      controllers.delete(key);
      if (onComplete) {
        Promise.resolve(onComplete()).catch((error) =>
          logFadeWarning(zoneId, 'fade completion handler', error),
        );
      }
      return;
    }

    controller.timer = setTimeout(runStep, stepDuration);
  };

  controller.timer = setTimeout(runStep, stepDuration);
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function logFadeWarning(zoneId: number, task: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  logger.warn(`[FadeUtils] Zone ${zoneId}: ${task} failed — ${message}`);
}
