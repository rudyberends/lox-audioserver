import { promises as fs } from 'fs';
import path from 'path';
import logger from '@/utils/troxorLogger';

/* -------------------------------------------------------------------------- */
/*  Directory and Path Helpers                                                */
/* -------------------------------------------------------------------------- */

/**
 * Ensures a directory exists, creating it recursively if necessary.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[fileUtils] Failed to ensure directory ${dirPath}: ${msg}`);
    throw err;
  }
}

/**
 * Resolves an absolute path inside the local data directory.
 * Example: resolveDataDir('favorites', '15.json')
 */
export function resolveDataDir(...segments: string[]): string {
  return path.resolve(process.cwd(), 'data', ...segments);
}

/* -------------------------------------------------------------------------- */
/*  JSON File Helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Reads and parses JSON from disk.
 * Returns `undefined` if the file does not exist or cannot be parsed.
 */
export async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data) as T;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      logger.warn(`[fileUtils] Failed to read JSON ${filePath}: ${e.message}`);
    }
    return undefined;
  }
}

/**
 * Writes a JSON object to disk, creating directories if necessary.
 * Pretty-prints with 2-space indentation for readability.
 */
export async function writeJson(filePath: string, data: unknown): Promise<void> {
  try {
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[fileUtils] Failed to write JSON ${filePath}: ${msg}`);
    throw err;
  }
}

/**
 * Reads a JSON file and returns its contents, or a fallback value if it doesn’t exist.
 * Optionally persists the fallback to disk automatically.
 *
 * @param filePath - The absolute path to the JSON file.
 * @param fallback - Default object returned when the file is missing or invalid.
 * @param persistFallback - If true, writes the fallback back to disk when missing.
 */
export async function readOrDefaultJson<T>(
  filePath: string,
  fallback: T,
  persistFallback = false,
): Promise<T> {
  const data = await readJson<T>(filePath);
  if (data !== undefined) {
    return data;
  }

  if (persistFallback) {
    await writeJson(filePath, fallback);
  }

  return fallback;
}