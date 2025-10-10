import logger from '../../utils/troxorlogger';

/**
 * Normalised shape we return to Loxone clients when reporting extension details.
 */
export type ExtensionDescriptor = {
  version: string;
  mac: string;
  serial: string;
  blinkpos?: number;
  type?: number;
  subtype?: number;
  btenable?: boolean;
  name?: string;
};

/**
 * Collapse the many variants of the MiniServer music config shape down to an array of plain objects.
 */
function normaliseMusicConfigs(raw: unknown): Record<string, any>[] {
  if (!raw) return [];

  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is Record<string, any> => !!entry && typeof entry === 'object');
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      return normaliseMusicConfigs(parsed);
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
 * Read an extension list from the provided config section, handling old/new casing and missing metadata.
 */
function extractExtensionsFromSection(section: Record<string, any> | undefined): ExtensionDescriptor[] {
  if (!section || typeof section !== 'object') return [];

  const candidates = [
    Array.isArray(section.extensions) ? section.extensions : null,
    Array.isArray(section.Extensions) ? section.Extensions : null,
  ];

  const source = candidates.find(Array.isArray);
  if (!source) return [];

  return source
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const serialRaw = typeof entry.serial === 'string' ? entry.serial.trim() : '';
      const macRaw = typeof entry.mac === 'string' ? entry.mac.trim() : '';
      const serial = serialRaw ? serialRaw.toUpperCase() : '';
      const mac = macRaw ? macRaw.toUpperCase() : serial;
      if (!serial && !mac) return null;
      const blinkposValue = Number(entry.blinkpos);
      const typeValue = Number(entry.type);
      const subtypeValue = Number(entry.subtype);
      const bluetooth =
        typeof entry.btenable === 'boolean'
          ? entry.btenable
          : typeof entry.btenable === 'string'
            ? entry.btenable.toLowerCase() === 'true'
            : undefined;
      return {
        version: typeof entry.version === 'string' && entry.version.trim() ? entry.version.trim() : '1.2.3',
        mac: mac || serial,
        serial: serial || mac,
        blinkpos: Number.isFinite(blinkposValue) ? blinkposValue : undefined,
        type: Number.isFinite(typeValue) ? typeValue : undefined,
        subtype: Number.isFinite(subtypeValue) ? subtypeValue : undefined,
        btenable: bluetooth,
        name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined,
      } as ExtensionDescriptor;
    })
    .filter((entry): entry is ExtensionDescriptor => Boolean(entry?.mac && entry.serial));
}

/**
 * Gather all extensions belonging to the current AudioServer from the cached MiniServer config.
 */
export function extractExtensions(raw: unknown, macId?: string): ExtensionDescriptor[] {
  const configs = normaliseMusicConfigs(raw);
  if (!configs.length) return [];

  const normalizedMacId = typeof macId === 'string' && macId.trim() ? macId.trim().toUpperCase() : undefined;
  const collected: ExtensionDescriptor[] = [];
  const seen = new Set<string>();

  configs.forEach((configEntry) => {
    if (!configEntry || typeof configEntry !== 'object') return;
    const section =
      normalizedMacId && configEntry[normalizedMacId]
        ? configEntry[normalizedMacId]
        : configEntry;

    extractExtensionsFromSection(section).forEach((ext) => {
      const key = `${ext.mac}|${ext.serial}`;
      if (seen.has(key)) return;
      seen.add(key);
      collected.push(ext);
    });
  });

  return collected;
}
