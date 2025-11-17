import { handleContentPlayCommand } from './contentPlaybackDispatch';

/**
 * Generic dispatcher for control and content-related commands.
 * Resolves commands in this order:
 *   1) Direct handler match
 *   2) Provider-specific content-play fallback
 */
export async function dispatch(
  command: string,
  handlers: Record<string, (() => Promise<void>) | undefined>,
  zoneId?: number,
  providerType?: string,
): Promise<boolean> {
  const key = command.toLowerCase();

  // 1) Direct handler lookup
  const fn = handlers[key];
  if (fn) {
    await fn();
    return true;
  }

  // 2) Fallback → provider-specific content-play (only if both fields exist)
  if (zoneId && providerType) {
    return await handleContentPlayCommand(key, zoneId, providerType);
  }

  return false;
}