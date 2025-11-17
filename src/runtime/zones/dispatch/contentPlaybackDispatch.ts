import { getContentPlayer } from '@/model/registry/contentPlayerRegistry';
import logger from '@/utils/troxorLogger';
import { ContentPlayCommand } from '@/core/types/contentPlaybackTypes';

/**
 * Central dispatcher for content playback.
 */
export async function handleContentPlayCommand(command: string, zoneId: number, providerType: string, payload?: unknown): Promise<boolean> {
  const normalized = command.toLowerCase();

  // Only these commands trigger playback.
  if (normalized !== 'contentplay' && normalized !== 'announce') {
    return false;
  }

  // Resolve provider-specific playback adapter.
  const key = `${providerType.toLowerCase()}-playback`;
  const PlayerCtor = getContentPlayer(key);

  if (!PlayerCtor) {
    logger.warn(`[ContentDispatch] No content playback adapter for "${key}"`);
    return false;
  }

  // Normalize incoming param → always array
  const args = Array.isArray(payload) ? payload : [payload];
  const uri = args[0];

  if (!uri) {
    logger.warn(`[ContentDispatch] Missing URI for ${normalized}`);
    return false;
  }

  // Only 'contentplay' supports shuffle as second argument.
  const shuffle = normalized === 'contentplay' ? args[1] === 'true' || args[1] === true : false;

  const cmd: ContentPlayCommand = {
    zoneId,
    item: uri,
    shuffle,
    type: normalized === 'announce' ? 'announce' : 'contentplay',
  };

  const player = new PlayerCtor({providerId: providerType, zoneId});
  await player.initialize?.();

  logger.debug(`[ContentDispatch] ${normalized} → ${uri} (shuffle=${shuffle}) via ${key}`);

  await player.handlePlayCommand(cmd);
  return true;
}