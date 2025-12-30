import { readdir, unlink } from 'node:fs/promises';
import { ensureDir, readOrDefaultJson, resolveDataDir, writeJson } from '@/core/utils/file';

export interface RecentStoreFile {
  ts: number;
  items: RecentItem[];
}

export interface RecentItem {
  audiopath: string;
  coverurl: string;
  owner: string;
  owner_id: string;
  service: string;
  serviceType: number;
  title: string;
  type: number;
  album?: string;
  artist?: string;
}

const RECENTS_DIR = resolveDataDir('recents');

function filePath(zoneId: number): string {
  return resolveDataDir('recents', `${zoneId}.json`);
}

function defaultRecents(): RecentStoreFile {
  return { ts: 0, items: [] };
}

export async function loadRecents(zoneId: number): Promise<RecentStoreFile> {
  await ensureDir(RECENTS_DIR);
  return readOrDefaultJson(filePath(zoneId), defaultRecents(), true);
}

export async function saveRecents(zoneId: number, data: RecentStoreFile): Promise<void> {
  await ensureDir(RECENTS_DIR);
  await writeJson(filePath(zoneId), data);
}

export async function clearAllRecents(): Promise<void> {
  await ensureDir(RECENTS_DIR);
  const entries = await readdir(RECENTS_DIR).catch(() => []);
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.endsWith('.json')) return;
      const target = resolveDataDir('recents', entry);
      try {
        await unlink(target);
      } catch {
        /* ignore */
      }
    }),
  );
}
