import { crc32 } from 'crc';

/**
 * Calculates a CRC32 checksum in the same format as the legacy implementation.
 */
export async function asyncCrc32(payload: string): Promise<string> {
  return (crc32(payload) >>> 0).toString(16).padStart(8, '0');
}
