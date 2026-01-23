import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@/shared/logging/logger';
import { safeJsonParse } from '@/shared/bestEffort';

const log = createLogger('Core', 'File');

/**
 * Ensures that the given directory path exists on disk.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Ensures that the given file path exists on disk.
 */
export async function ensureFile(
  filePath: string,
  contents: Buffer | string = '',
): Promise<void> {
  try {
    await fs.access(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, contents);
      return;
    }
    throw error;
  }
}

/**
 * Reads a file and returns its raw buffer.
 */
export async function readFileBuffer(filePath: string): Promise<Buffer> {
  return fs.readFile(filePath);
}

/**
 * Resolves an absolute path under the `/data` directory.
 */
export function resolveDataDir(...segments: string[]): string {
  return path.resolve(process.cwd(), 'data', ...segments);
}

/**
 * Reads a JSON file and returns its parsed value (or undefined if missing).
 */
export async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = safeJsonParse<T | undefined>(content, undefined, {
      onError: 'debug',
      log,
      label: 'json parse failed',
      context: { filePath },
    });
    if (parsed === undefined) {
      log.warn('failed to read json', { filePath, error: 'invalid json' });
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('failed to read json', { filePath, error: (error as Error).message });
    }
    return undefined;
  }
}

/**
 * Serializes an object to JSON and writes it to disk (pretty printed).
 */
export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Reads a JSON file or returns a fallback value (optionally persisting it).
 */
export async function readOrDefaultJson<T>(
  filePath: string,
  fallback: T,
  persistFallback = false,
): Promise<T> {
  const data = await readJson<T>(filePath);
  if (data) {
    return data;
  }
  if (persistFallback) {
    await writeJson(filePath, fallback);
  }
  return fallback;
}
