import { decodeAudiopath } from '@/core/loxone/mediaMapping';

export const CONTENT_COMMANDS = [
  'libraryplay',
  'serviceplay',
  'playlistplay',
  'urlplay',
  'favoriteplay',
  'alertplay',
] as const;

export type ContentCommandType = typeof CONTENT_COMMANDS[number];

export interface ParsedContentPayload {
  readonly item: string;
  readonly startItem?: string;
  readonly shuffle: boolean;
}

/**
 * Parse a Loxone playback command parameter.
 * Handles `/parentpath/...` pattern and `noshuffle` suffixes.
 */
export function parseLoxoneCommand(param: unknown): ParsedContentPayload {
  const args = Array.isArray(param) ? param.map(String) : [String(param ?? '')];
  const raw = decodeURIComponent(args[0] ?? '').trim();

  const shuffle =
    args.some(a => a?.toLowerCase?.() === 'true' || a === '1' || a === 'shuffle');

  let item = raw;
  let startItem: string | undefined;

  if (raw.includes('/parentpath/')) {
    const [childRaw, parentRaw] = raw.split('/parentpath/');

    // decode base64 audiopath back to original
    const decoded = decodeAudiopath(childRaw);
    startItem = decoded.split('/').pop(); // only ID (e.g. "3139")

    // strip trailing numeric index and optional /noshuffle parts
    item = parentRaw
      .replace(/\/\d+(?:\/noshuffle.*)?$/i, '') // removes "/0" or "/3/noshuffle"
      .replace(/\/+$/, '');
  }

  return { item, startItem, shuffle };
}