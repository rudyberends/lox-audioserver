import { handleContentPlayCommand } from './contentPlaybackDispatch';

/**
 * Generic dispatcher for control and content-related commands.
 * Extends basic handler lookup with provider-specific content fallback.
 */
export async function dispatch(
  command: string,
  handlers: Record<string, (() => Promise<void>) | undefined>,
  zoneId?: number,
  providerType?: string,
): Promise<boolean> {
  const key = String(command || '').toLowerCase();

  // First, check local handler map
  const fn = handlers[key];
  if (fn) {
    await fn();
    return true;
  }

  // Fallback → content play handler (libraryplay, serviceplay, etc.)
  if (zoneId && providerType) {
    const handled = await handleContentPlayCommand(key, zoneId, providerType);
    if (handled) {
      return true;
    }
  }

  return false;
}