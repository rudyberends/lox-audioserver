import logger from '@/utils/troxorLogger';

/**
 * -----------------------------------------------------------------------------
 * Extension Extraction Utilities
 * -----------------------------------------------------------------------------
 * Normalizes and extracts AudioServer extension metadata (e.g., BT modules,
 * AMP, SourceExt, etc.) from the MiniServer music configuration.
 *
 * Supports multiple configuration shapes (arrays, objects, or serialized JSON)
 * and handles inconsistent casing of `extensions` vs. `Extensions`.
 * -----------------------------------------------------------------------------
 */

/**
 * Normalized shape describing a connected AudioServer extension.
 */
export interface ExtensionDescriptor {
  version: string;
  mac: string;
  serial: string;
  blinkpos?: number;
  type?: number;
  subtype?: number;
  btenable?: boolean;
  name?: string;
}

/* -------------------------------------------------------------------------- */
/*                              Internal Helpers                              */
/* -------------------------------------------------------------------------- */

/**
 * Converts any valid MiniServer music configuration variant
 * (stringified JSON, array, or nested object) into a normalized array.
 */
function normalizeMusicConfigs(raw: unknown): Record<string, any>[] {
  if (!raw) {
    return [];
  }

  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is Record<string, any> => !!entry && typeof entry === 'object');
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return [];
    }
    try {
      const parsed = JSON.parse(trimmed);
      return normalizeMusicConfigs(parsed);
    } catch (error) {
      logger.warn(
        `[extensions] Failed to parse music configuration string: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  if (typeof raw === 'object') {
    const values = Object.values(raw as Record<string, any>).filter(
      (value): value is Record<string, any> => !!value && typeof value === 'object',
    );
    return values.length ? values : [raw as Record<string, any>];
  }

  return [];
}

/**
 * Extracts extensions from a single configuration section,
 * supporting both `extensions` and `Extensions` casing.
 */
function extractExtensionsFromSection(section: Record<string, any> | undefined): ExtensionDescriptor[] {
  if (!section || typeof section !== 'object') {
    return [];
  }

  const source =
    (Array.isArray(section.extensions) && section.extensions) ||
    (Array.isArray(section.Extensions) && section.Extensions) ||
    null;

  if (!source) {
    return [];
  }

  return source
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const serialRaw = typeof entry.serial === 'string' ? entry.serial.trim() : '';
      const macRaw = typeof entry.mac === 'string' ? entry.mac.trim() : '';
      const serial = serialRaw.toUpperCase();
      const mac = macRaw.toUpperCase() || serial;

      if (!serial && !mac) {
        return null;
      }

      const blinkpos = Number(entry.blinkpos);
      const type = Number(entry.type);
      const subtype = Number(entry.subtype);

      const btenable =
      typeof entry.btenable === 'boolean'
        ? entry.btenable
        : typeof entry.btenable === 'string'
          ? entry.btenable.toLowerCase() === 'true'
          : undefined;

      const version =
      typeof entry.version === 'string' && entry.version.trim() ? entry.version.trim() : '1.2.3';
      const name =
      typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined;

      return {
        version,
        mac,
        serial,
        ...(Number.isFinite(blinkpos) ? { blinkpos } : {}),
        ...(Number.isFinite(type) ? { type } : {}),
        ...(Number.isFinite(subtype) ? { subtype } : {}),
        ...(btenable !== undefined ? { btenable } : {}),
        ...(name ? { name } : {}),
      } as ExtensionDescriptor;
    })
    .filter((entry): entry is ExtensionDescriptor => !!entry);

}

/* -------------------------------------------------------------------------- */
/*                              Public Function                               */
/* -------------------------------------------------------------------------- */

/**
 * Gathers all extensions belonging to the current AudioServer
 * from a MiniServer-provided configuration payload.
 *
 * @param raw - The raw MiniServer music configuration (object, array, or JSON string).
 * @param macId - Optional AudioServer MAC identifier used to select the correct section.
 * @returns Array of unique, normalized extension descriptors.
 */
export function extractExtensions(raw: unknown, macId?: string): ExtensionDescriptor[] {
  const configs = normalizeMusicConfigs(raw);
  if (!configs.length) {
    return [];
  }

  const normalizedMacId = typeof macId === 'string' && macId.trim() ? macId.trim().toUpperCase() : undefined;
  const collected: ExtensionDescriptor[] = [];
  const seen = new Set<string>();

  for (const configEntry of configs) {
    if (!configEntry || typeof configEntry !== 'object') {
      continue;
    }

    const section =
      normalizedMacId && configEntry[normalizedMacId]
        ? configEntry[normalizedMacId]
        : configEntry;

    for (const ext of extractExtensionsFromSection(section)) {
      const key = `${ext.mac}|${ext.serial}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      collected.push(ext);
    }
  }

  return collected;
}
