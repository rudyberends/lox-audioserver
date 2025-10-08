import fs from 'fs';
import path from 'path';

import { CONFIG_DIR } from './configStore';

const MUSIC_CACHE_FILE = process.env.MUSIC_CACHE_FILE || path.join(CONFIG_DIR, 'music-cache.json');

export interface MusicCachePayload {
  crc32: string;
  musicCFG: unknown;
  timestamp?: number;
}

export function loadMusicCache(): MusicCachePayload | null {
  try {
    if (!fs.existsSync(MUSIC_CACHE_FILE)) {
      return null;
    }

    const raw = fs.readFileSync(MUSIC_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<MusicCachePayload>;

    if (!parsed || typeof parsed.crc32 !== 'string' || parsed.musicCFG === undefined) {
      return null;
    }
    const timestamp = typeof parsed.timestamp === 'number' ? parsed.timestamp : undefined;

    return { crc32: parsed.crc32, musicCFG: parsed.musicCFG, timestamp };
  } catch (error) {
    // Corrupt cache should not be fatal; treat as a cache miss.
    return null;
  }
}

export function saveMusicCache(payload: MusicCachePayload): void {
  ensureConfigDir();
  const serialized = `${JSON.stringify(payload)}\n`;
  fs.writeFileSync(MUSIC_CACHE_FILE, serialized, 'utf8');
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}
