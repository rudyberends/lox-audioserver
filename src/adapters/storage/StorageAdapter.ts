import { promises as fs } from 'node:fs';
import type { StoragePort } from '@/ports/StoragePort';
import { readJson, writeJson } from '@/shared/utils/file';

export class StorageAdapter implements StoragePort {
  public async readJson<T>(
    filePath: string,
    fallback: T,
    options?: { writeIfMissing?: boolean },
  ): Promise<T> {
    const data = await readJson<T>(filePath);
    if (data !== undefined) {
      return data;
    }
    if (options?.writeIfMissing) {
      await writeJson(filePath, fallback);
    }
    return fallback;
  }

  public async writeJson(filePath: string, data: unknown): Promise<void> {
    await writeJson(filePath, data);
  }

  public async list(dirPath: string): Promise<string[]> {
    try {
      return await fs.readdir(dirPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  public async remove(filePath: string): Promise<void> {
    try {
      await fs.rm(filePath, { force: true });
    } catch {
      /* ignore */
    }
  }
}
