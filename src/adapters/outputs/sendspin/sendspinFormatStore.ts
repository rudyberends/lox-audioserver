import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveDataDir } from '@/shared/utils/file';
import type { PcmBitDepth } from '@/ports/types/audioFormat';
import type { PlayerFormatWithBitDepth } from '@sonn-audio/node-sendspin';

type SendspinFormat = PlayerFormatWithBitDepth<PcmBitDepth>;

/**
 * Per-client PCM format persistence.
 *
 * A Sendspin client's negotiated format (e.g. 48 kHz/24-bit for a 48 kHz-only
 * amp) is only learned from the client's `onFormatChanged` callback and kept in
 * memory on the SendspinOutput. That in-memory value is lost on a lox restart,
 * so the FIRST play in a room after a restart advertises the 44.1 kHz stream
 * default — the engine starts there and, on a 48 kHz-only sink, renders noise
 * (or restarts mid-stream). Persisting the format keyed by clientId lets
 * getPreferredOutput() advertise the real rate immediately, so the engine starts
 * aligned even on the first play after a restart.
 */
const FILE = resolveDataDir('sendspin', 'client-formats.json');
let cache: Record<string, SendspinFormat> | null = null;

function load(): Record<string, SendspinFormat> {
  if (!cache) {
    try {
      cache = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, SendspinFormat>;
    } catch {
      cache = {};
    }
  }
  return cache;
}

export function getStoredClientFormat(clientId: string): SendspinFormat | null {
  if (!clientId) {
    return null;
  }
  const fmt = load()[clientId];
  // Return a copy: the cache is shared across all SendspinOutput instances and the
  // caller stores this into a mutable per-instance field.
  return fmt ? { ...fmt } : null;
}

export function rememberClientFormat(clientId: string, fmt: SendspinFormat): void {
  if (!clientId) {
    return;
  }
  const store = load();
  const prev = store[clientId];
  if (
    prev &&
    prev.codec === fmt.codec &&
    prev.sampleRate === fmt.sampleRate &&
    prev.channels === fmt.channels &&
    prev.bitDepth === fmt.bitDepth
  ) {
    return; // unchanged — skip the write
  }
  store[clientId] = fmt;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(store, null, 2));
  } catch {
    /* best-effort: a lost write just means the next play re-learns the format */
  }
}
