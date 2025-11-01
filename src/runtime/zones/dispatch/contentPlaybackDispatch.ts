import { getContentPlayer } from '@/model/registry/contentPlayerRegistry';
import logger from '@/utils/troxorLogger';
import { ContentPlayCommand } from '@/core/types/contentPlaybackTypes';

/**
 * Central dispatcher for provider-specific content playback commands.
 */
export async function handleContentPlayCommand(
  command: string,
  zoneId: number,
  providerType: string,
  payload?: any,
): Promise<boolean> {
  try {
    const normalized = String(command || '').toLowerCase();
    const supported = ['libraryplay', 'serviceplay', 'playlistplay', 'urlplay', 'favoriteplay'];
    if (!supported.includes(normalized)) {
      return false;
    }

    const key = `${providerType.toLowerCase()}-playback`;
    const Ctor = getContentPlayer(key);
    if (!Ctor) {
      logger.warn(`[ContentDispatch] No ContentPlayer registered for "${key}"`);
      return false;
    }

    const args = Array.isArray(payload) ? payload : [payload];
    const uri = args[0];
    const shuffle = args[1] === 'true' || args[1] === true;

    if (!uri) {
      logger.warn(`[ContentDispatch] Missing URI for "${normalized}"`);
      return false;
    }

    const cmd: ContentPlayCommand = {
      zoneId,
      item: uri,
      type: 'unknown',
      shuffle,
    };
    const player = new Ctor({ providerId: providerType, zoneId });

    await player.initialize?.();
    logger.debug(
      `[ContentDispatch] Handling "${normalized}" via ${providerType}-playback (zone ${zoneId})`,
    );

    if (typeof player.handlePlayCommand === 'function') {
      await player.handlePlayCommand(cmd);
      return true;
    }

    logger.warn(`[ContentDispatch] Adapter "${providerType}" has no handlePlayCommand()`);
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[ContentDispatch] Failed to handle ${command}: ${msg}`);
    return false;
  }
}