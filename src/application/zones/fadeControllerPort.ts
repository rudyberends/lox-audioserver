import type { FadeControllerPort } from '@/ports/FadeControllerPort';
import { fadeController } from '@/application/zones/fadeController';

export function createFadeControllerPort(): FadeControllerPort {
  return {
    parseFadeOptions: (raw) => fadeController.parseFadeOptions(raw),
    fadeIn: (zoneId, durationMs) => fadeController.fadeIn(zoneId, durationMs),
  };
}
