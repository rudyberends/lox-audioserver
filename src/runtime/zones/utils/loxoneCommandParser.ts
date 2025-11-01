/**
 * loxoneCommandParser.ts
 * ----------------------
 * Small, focused utilities to normalize Loxone "serviceplay/playlistplay/..." payloads.
 *
 * Responsibilities
 * - Accept a raw `param` from ZoneRuntime (string or array)
 * - Extract a clean `item` URI (adapter-agnostic)
 * - Optionally extract a numeric `startItem` if a `/parentpath/.../<index>` exists
 * - Derive `shuffle` from the Loxone argument convention (2nd arg = 'true'|'false'|boolean)
 *
 * The output is intentionally minimal, so adapters remain in control of adapter-specific parsing.
 */

import logger from '@/utils/troxorLogger';

/** Exact set of content commands routed via the content playback mapper. */
export const CONTENT_COMMANDS = [
  'libraryplay',
  'serviceplay',
  'playlistplay',
  'urlplay',
  'favoriteplay',
  'alertplay',
] as const;

export type ContentCommandType = typeof CONTENT_COMMANDS[number];

/** Parsed shape returned to ZoneRuntime before it calls the content mapper. */
export interface ParsedContentPayload {
  /** Clean, adapter-agnostic item URI (e.g. "library://album/629" or "library://track/4528"). */
  readonly item: string;
  /** Optional start item (e.g. "2366") when `/parentpath/.../<index>` was present. */
  readonly startItem?: string;
  /** Shuffle flag derived from Loxone param convention. */
  readonly shuffle: boolean;
}

/**
 * Normalize a raw "param" from ZoneRuntime into a string array.
 * - Loxone often sends either a single string or an array of strings.
 */
function normalizeArgs(param: unknown): readonly string[] {
  if (Array.isArray(param)) {
    return param.map(String);
  }
  if (param == null) {
    return [];
  }
  return [String(param)];
}

/** Remove trailing query string from a URI. */
function stripQuery(uri: string): string {
  return uri.replace(/\?.*$/, '');
}

/** Remove known legacy Loxone prefixes/hacks that sometimes show up. */
function stripLegacyPrefixes(uri: string): string {
  let out = uri;
  out = out.replace(/^spotify\/nouser\//i, '');
  out = out.replace(/^spotify:track:0\//i, '');
  return out;
}

/** Remove a single trailing slash, if present. */
function stripTrailingSlash(uri: string): string {
  return uri.replace(/\/+$/, '');
}

/**
 * Given a path like "library://album/629/12/noshuffle" return only the ID path:
 * - "library://album/629"
 * If no numeric segment is found, the original path is returned unchanged.
 */
function stripToEntityIdPath(path: string): string {
  const m = path.match(/^([a-z0-9_]+:\/\/[^/]+\/\d+)/i);
  return m ? m[1] : path;
}

/** From a child path like "library://track/5978" return its tail "5978". */
function extractLastNumericSegment(path: string): string | undefined {
  const seg = path.split('/').pop() ?? '';
  return /^\d+$/.test(seg) ? seg : undefined;
}

/**
 * Parse a Loxone content command payload.
 *
 * @param param Unknown payload (string | string[] | other)
 * @param type  One of the known content command types (serviceplay, playlistplay, ...)
 * @returns     ParsedContentPayload with clean item, optional startItem, and shuffle flag
 */
export function parseLoxoneCommand(param: unknown, type: ContentCommandType): ParsedContentPayload {
  const args = normalizeArgs(param);

  // Loxone "serviceplay" usually receives [account, uri, ...]
  // others (playlistplay, libraryplay, ...) typically receive [uri]
  const raw = type === 'serviceplay' && args.length > 1 ? args[1] : args[0];
  const value = args[1];
  const shuffle =
    (typeof value === 'boolean' && value) ||
    (typeof value === 'string' && value.toLowerCase() === 'true');
  if (!raw) {
    return { item: '', shuffle };
  }

  // Decode and basic cleanup
  let uri = decodeURIComponent(String(raw)).trim();
  uri = stripQuery(uri);
  uri = stripLegacyPrefixes(uri);

  // v1: If a "parentpath" exists, swap: parent becomes main item, child provides start index
  let item = uri;
  let startItem: string | undefined;

  if (uri.includes('/parentpath/')) {
    const [childRaw, parentRaw] = uri.split('/parentpath/');
    const parentClean = stripTrailingSlash(parentRaw)
      // historic: sometimes "noshuffle" sneaks into the tail; keep robust
      .replace(/\/noshuffle(?:\/|$)/i, '')
      .replace(/\/\d+\/noshuffle(?:\/|$)/i, '');

    item = stripToEntityIdPath(parentClean);

    // Start from the child tail (numeric only)
    startItem = extractLastNumericSegment(childRaw);
  }

  // Remove leading "provider/" if it immediately prefixes a proper "<scheme>://".
  while (/^[a-z0-9_]+\/[a-z0-9_]+:\/\//i.test(item)) {
    item = item.substring(item.indexOf('/') + 1);
  }

  item = stripTrailingSlash(item);

  logger.debug(
    `[LoxoneCommandParser] Parsed → item=${item || '-'}, start=${startItem ?? '-'}, shuffle=${shuffle}`,
  );

  return { item, startItem, shuffle };
}