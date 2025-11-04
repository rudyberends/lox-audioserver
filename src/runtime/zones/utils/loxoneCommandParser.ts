import { decodeAudiopath } from '@/core/loxone/mediaMapping';

export const CONTENT_COMMANDS = [
  'libraryplay',
  'serviceplay',
  'playlistplay',
  'playurl',
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
 * Decode Loxone/MusicAssistant audiopaths containing base64 payloads.
 * Examples:
 *  - tunein:station:bGlicmFyeTovL3JhZGlvLzEw   → library://radio/10
 *  - spotify@nouser:track:YXBwbGVfbXVzaWM6Ly90cmFjay8xMzQzOTY0MjY4 → apple_music://track/1343964268
 *  - library://track/12345 → passthrough
 */
export function parseLoxoneCommand(param: unknown): ParsedContentPayload {
  const args = Array.isArray(param) ? param.map(String) : [String(param ?? '')];
  const raw = (args[0] ?? '').trim();
  const cleanedRaw = raw.split('?')[0]; // strip query params

  const shuffle = args.some(a => /^(true|1|shuffle)$/i.test(a ?? ''));

  // Handle nested parent reference (used for albums/playlists)
  if (cleanedRaw.includes('/parentpath/')) {
    const [child, parent] = cleanedRaw.split('/parentpath/');
    const decodedChild = decodeAudiopath(child);
    const startItem = decodedChild.split('/').pop();

    const item = parent
      .replace(/\/\d+(?:\/noshuffle.*)?$/i, '')
      .replace(/\/+$/, '');

    return { item, startItem, shuffle };
  }

  // --- Simple path (no parent reference) ---
  const stripped = cleanedRaw.replace(/\/noshuffle.*$/i, '').replace(/\/+$/, '');

  // If already a plain URI (e.g. library://radio/10), don't decode again
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(stripped)) {
    return { item: stripped, shuffle };
  }

  // Extract only the base64 token after the last ":" (if present)
  const afterColon = stripped.slice(stripped.lastIndexOf(':') + 1);
  const token = afterColon.split('/')[0];

  const item = /^[A-Za-z0-9+/=]+$/.test(token)
    ? decodeAudiopath(token)
    : stripped;

  return { item, shuffle };
}