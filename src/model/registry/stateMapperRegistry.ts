import logger from '@/utils/troxorLogger';

/**
 * -----------------------------------------------------------------------------
 * StateMapperRegistry
 * -----------------------------------------------------------------------------
 * Beheert alle device-/protocolspecifieke state mappers.
 * Een StateMapper vertaalt inkomende device-events (NDJSON, MQTT, WebSocket, ...)
 * naar genormaliseerde `ZoneState`-updates.
 * -----------------------------------------------------------------------------
 */

export interface StateMapperMeta {
  description?: string;
  sourceType?: string;
  version?: string;
}

export interface StateMapperConstructor<TParams = Record<string, any>> {
  new (params: TParams): any; // kan later gespecificeerd worden naar BaseStateMapper<T>
}

interface RegistryEntry {
  ctor: StateMapperConstructor;
  meta?: StateMapperMeta;
}

const registry = new Map<string, RegistryEntry>();

/* -------------------------------------------------------------------------- */
/* Registratie                                                                */
/* -------------------------------------------------------------------------- */

export function registerStateMapper(
  id: string,
  ctor: StateMapperConstructor,
  meta?: StateMapperMeta,
): void {
  const key = id.toLowerCase();

  if (registry.has(key)) {
    logger.warn(`[StateMapperRegistry] Overwriting existing mapper for "${id}".`);
  }

  registry.set(key, { ctor, meta });
  const metaInfo = meta?.description ? ` (${meta.description})` : '';
  logger.debug(`[StateMapperRegistry] Registered mapper "${id}"${metaInfo}`);
}

/* -------------------------------------------------------------------------- */
/* Resolutie                                                                  */
/* -------------------------------------------------------------------------- */

export function getStateMapper(id: string): StateMapperConstructor | undefined {
  return registry.get(id.toLowerCase())?.ctor;
}

export function listStateMappers(): string[] {
  return Array.from(registry.keys());
}

export function getStateMapperMeta(id: string): StateMapperMeta | undefined {
  return registry.get(id.toLowerCase())?.meta;
}