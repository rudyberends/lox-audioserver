import logger from '@/utils/troxorLogger';

import type { AdapterConfigSchema } from './commandMapperRegistry';

export interface ContentProviderMeta {
  description?: string;
  version?: string;
  displayName?: string;
  configSchema?: AdapterConfigSchema;
}

export interface ContentProviderConstructor<TParams = Record<string, any>> {
  new (params: TParams): any;
}

interface RegistryEntry {
  ctor: ContentProviderConstructor;
  meta?: ContentProviderMeta;
}

const registry = new Map<string, RegistryEntry>();

export function registerContentProvider(
  id: string,
  ctor: ContentProviderConstructor,
  meta?: ContentProviderMeta,
): void {
  const key = id.toLowerCase();
  if (registry.has(key)) {
    logger.warn(`[ContentProviderRegistry] Overwriting existing mapper for "${id}".`);
  }
  registry.set(key, { ctor, meta });
  const metaInfo = meta?.description ? ` (${meta.description})` : '';
  logger.debug(`[ContentProviderRegistry] Registered mapper "${id}"${metaInfo}`);
}

export function getContentProvider(id: string): ContentProviderConstructor | undefined {
  return registry.get(id.toLowerCase())?.ctor;
}

export function listContentProviders(): string[] {
  return Array.from(registry.keys());
}

export function getContentProviderMeta(id: string): ContentProviderMeta | undefined {
  return registry.get(id.toLowerCase())?.meta;
}
