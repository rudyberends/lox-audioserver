import { createLogger } from '@/core/logging/logger';
import { sendspinCore } from '@lox-audioserver/node-sendspin';
import type { SendspinSessionHooks } from '@lox-audioserver/node-sendspin';

type HookEntry = {
  hooks: Set<SendspinSessionHooks>;
  combined: SendspinSessionHooks;
};

const log = createLogger('Sendspin', 'Hooks');
const entries = new Map<string, HookEntry>();

function dispatch<K extends keyof SendspinSessionHooks>(
  clientId: string,
  key: K,
  ...args: Parameters<NonNullable<SendspinSessionHooks[K]>>
): void {
  const entry = entries.get(clientId);
  if (!entry) return;
  for (const hooks of entry.hooks) {
    const handler = hooks[key];
    if (!handler) continue;
    try {
      (handler as (...handlerArgs: typeof args) => void)(...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('sendspin hook failed', { clientId, hook: key, message });
    }
  }
}

function buildCombined(clientId: string): SendspinSessionHooks {
  return {
    onPlayerState: (...args) => dispatch(clientId, 'onPlayerState', ...args),
    onGroupCommand: (...args) => dispatch(clientId, 'onGroupCommand', ...args),
    onSourceState: (...args) => dispatch(clientId, 'onSourceState', ...args),
    onSourceCommand: (...args) => dispatch(clientId, 'onSourceCommand', ...args),
    onSourceAudio: (...args) => dispatch(clientId, 'onSourceAudio', ...args),
    onIdentified: (...args) => dispatch(clientId, 'onIdentified', ...args),
    onDisconnected: (...args) => dispatch(clientId, 'onDisconnected', ...args),
    onFormatChanged: (...args) => dispatch(clientId, 'onFormatChanged', ...args),
    onGoodbye: (...args) => dispatch(clientId, 'onGoodbye', ...args),
    onUnsupportedRoles: (...args) => dispatch(clientId, 'onUnsupportedRoles', ...args),
  };
}

export function registerSendspinHooks(clientId: string, hooks: SendspinSessionHooks): () => void {
  const trimmed = clientId.trim();
  if (!trimmed) {
    return () => {};
  }
  let entry = entries.get(trimmed);
  if (!entry) {
    entry = { hooks: new Set<SendspinSessionHooks>(), combined: buildCombined(trimmed) };
    entries.set(trimmed, entry);
    sendspinCore.registerHooks(trimmed, entry.combined);
    log.debug('sendspin hooks activated', { clientId: trimmed });
  }
  entry.hooks.add(hooks);
  log.debug('sendspin hooks registered', { clientId: trimmed, listeners: entry.hooks.size });
  return () => {
    const current = entries.get(trimmed);
    if (!current) return;
    current.hooks.delete(hooks);
    if (current.hooks.size === 0) {
      entries.delete(trimmed);
      sendspinCore.unregisterHooks(trimmed);
      log.debug('sendspin hooks cleared', { clientId: trimmed });
      return;
    }
    log.debug('sendspin hooks removed', { clientId: trimmed, listeners: current.hooks.size });
  };
}
