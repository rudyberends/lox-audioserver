import logger from '@/utils/troxorLogger';

/**
 * -----------------------------------------------------------------------------
 * CommandMapperRegistry
 * -----------------------------------------------------------------------------
 * Beheert alle device-/protocolspecifieke command mappers.
 * Een CommandMapper vertaalt generieke zonecommando’s (zoals play/pause/volume)
 * naar concrete backend-acties via HTTP, TCP, MQTT, enzovoort.
 * -----------------------------------------------------------------------------
 */

export type AdapterFieldInputType =
  | 'text'
  | 'number'
  | 'password'
  | 'select'
  | 'discoveredSelect'
  | 'checkbox';

export interface AdapterFieldDiscovery {
  /**
   * Identifier that frontends can use to decide how to perform discovery (e.g. "musicassistantPlayers").
   */
  type: string;
  /**
   * Optional API endpoint exposed by the admin HTTP server to perform the discovery.
   * If omitted, the discovery type is expected to be handled client-side.
   */
  endpoint?: string;
  /**
   * HTTP method used for the discovery endpoint. Defaults to GET.
   */
  method?: 'GET' | 'POST';
  /**
   * List of field ids whose values must be provided when invoking the discovery endpoint.
   */
  requires?: string[];
}

export interface AdapterConfigField {
  id: string;
  label: string;
  inputType: AdapterFieldInputType;
  required?: boolean;
  placeholder?: string;
  helpText?: string;
  defaultValue?: string | number | boolean;
  /**
   * Static options for select inputs.
   */
  options?: Array<{ value: string; label: string }>;
  /**
   * Discovery metadata for dynamically populated selects.
   */
  discovery?: AdapterFieldDiscovery;
}

export interface AdapterConfigSchema {
  fields: AdapterConfigField[];
}

export interface CommandMapperMeta {
  description?: string;
  version?: string;
  /**
   * Human friendly name for UI display.
   */
  displayName?: string;
  /**
   * Optional configuration schema describing how this adapter should be configured in the admin UI.
   */
  configSchema?: AdapterConfigSchema;
  /**
   * Optional suggestion for which media provider type pairs best with this adapter (e.g., "musicassistant").
   */
  suggestedProviderType?: string;
}

export interface CommandMapperConstructor<TParams = Record<string, any>> {
  new (params: TParams): any; // kan later gespecificeerd worden naar BaseCommandMapper<T>
}

export type CommandMapperValidator = (params: Record<string, any>) => Promise<void>;

interface RegistryEntry {
  ctor: CommandMapperConstructor;
  meta?: CommandMapperMeta;
  validate?: CommandMapperValidator;
}

const registry = new Map<string, RegistryEntry>();

/* -------------------------------------------------------------------------- */
/* Registratie                                                                */
/* -------------------------------------------------------------------------- */

export function registerCommandMapper(
  id: string,
  ctor: CommandMapperConstructor,
  meta?: CommandMapperMeta,
  options?: { validate?: CommandMapperValidator },
): void {
  const key = id.toLowerCase();

  if (registry.has(key)) {
    logger.warn(`[CommandMapperRegistry] Overwriting existing mapper for "${id}".`);
  }

  registry.set(key, { ctor, meta, validate: options?.validate });
  const metaInfo = meta?.description ? ` (${meta.description})` : '';
  logger.debug(`[CommandMapperRegistry] Registered mapper "${id}"${metaInfo}`);
}

/* -------------------------------------------------------------------------- */
/* Resolutie                                                                  */
/* -------------------------------------------------------------------------- */

export function getCommandMapper(id: string): CommandMapperConstructor | undefined {
  return registry.get(id.toLowerCase())?.ctor;
}

export function listCommandMappers(): string[] {
  return Array.from(registry.keys());
}

export function getCommandMapperMeta(id: string): CommandMapperMeta | undefined {
  return registry.get(id.toLowerCase())?.meta;
}

export function getCommandMapperValidator(id: string): CommandMapperValidator | undefined {
  return registry.get(id.toLowerCase())?.validate;
}
