import { isIP } from 'node:net';
import { MusicAssistantApi } from '@/shared/musicassistant/musicAssistantApi';
import { withTimeout } from '@/adapters/http/adminApi/helpers/withTimeout';

export type MusicAssistantConnectionResult = {
  ok: boolean;
  checkedAt: number;
  message?: string;
  host: string;
  port: number;
};

/**
 * Validates a Music Assistant host string: must be a literal IP, or a DNS name
 * that fits standard length/character rules. Empty/0.0.0.0/URLs are rejected.
 */
export function isValidMusicAssistantHost(host: string): boolean {
  const trimmed = host.trim();
  if (!trimmed || trimmed === '0.0.0.0') return false;
  const bracketed =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1).trim() : trimmed;
  if (isIP(bracketed)) return true;
  if (trimmed.includes('://')) return false;
  if (trimmed.length > 253) return false;
  const labels = trimmed.split('.');
  if (labels.some((label) => !label || label.length > 63)) return false;
  return labels.every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

/**
 * Smoke-test that the Music Assistant bridge is reachable with the given
 * credentials. Always releases the API handle, even on failure.
 */
export async function testMusicAssistantBridge(
  host: string,
  port: number,
  apiKey: string,
): Promise<MusicAssistantConnectionResult> {
  const checkedAt = Date.now();
  const api = MusicAssistantApi.acquire(host, port, apiKey);
  try {
    await withTimeout(api.connect(), 8000, 'music assistant connection timed out');
    return { ok: true, checkedAt, host, port };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, checkedAt, message, host, port };
  } finally {
    api.release();
  }
}
