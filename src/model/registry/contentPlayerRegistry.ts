import logger from '@/utils/troxorLogger';

export interface ContentPlayerMeta {
  description?: string;
  version?: string;
  displayName?: string;
  providerType?: string;
  requiresPlayerId?: boolean;
}

export interface ContentPlayerConstructor {
  new (init: {
    providerId: string;
    zoneId: number;
    zoneName?: string;
    ip?: string;
    port?: number;
    playerId?: string;
    [key: string]: any;
  }): any;
}

interface RegistryEntry {
  ctor: ContentPlayerConstructor;
  meta?: ContentPlayerMeta;
}

const registry = new Map<string, RegistryEntry>();

export function registerContentPlayer(
  id: string,
  ctor: ContentPlayerConstructor,
  meta?: ContentPlayerMeta,
): void {
  const key = id.toLowerCase();
  if (registry.has(key)) {
    logger.warn(`[ContentPlayerRegistry] Overwriting existing mapper for "${id}".`);
  }
  registry.set(key, { ctor, meta });
  const metaInfo = meta?.description ? ` (${meta.description})` : '';
  logger.debug(`[ContentPlayerRegistry] Registered mapper "${id}"${metaInfo}`);
}

export function getContentPlayer(id: string): ContentPlayerConstructor | undefined {
  return registry.get(id.toLowerCase())?.ctor;
}

export function listContentPlayers(): string[] {
  return Array.from(registry.keys());
}

export function getContentPlayerMeta(id: string): ContentPlayerMeta | undefined {
  return registry.get(id.toLowerCase())?.meta;
}
