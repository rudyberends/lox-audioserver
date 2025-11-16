import path from 'node:path';
import { promises as fs } from 'node:fs';
import logger from '@/utils/troxorLogger';
import { emptyCommand } from '../requestHandler';
import { ensureDir } from '@/core/utils/file';

export async function audioCfgUploadAudioAdd(url: string, data?: Buffer) {
  // url: audio/cfg/upload/audioupload/add/filename.wav
  const parts = url.split('/');
  const filename = parts[5];

  if (!filename) {
    logger.warn('[Upload] Missing filename');
    return emptyCommand(url, []);
  }

  if (!data || data.length === 0) {
    logger.warn('[Upload] Missing binary data in request body');
    return emptyCommand(url, []);
  }

  // public/alerts/cache/<filename>
  const uploadDir = path.join(process.cwd(), 'public/alerts/cache');
  await ensureDir(uploadDir);

  const dest = path.join(uploadDir, filename);

  try {
    await fs.writeFile(dest, data);
    logger.info(`[Upload] Stored uploaded alert → ${dest}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[Upload] Failed to store uploaded alert ${filename}: ${msg}`);
    // desnoods nog een foutcode teruggeven, maar emptyCommand is Loxone-safe
    return emptyCommand(url, []);
  }

  return emptyCommand(url, []);
}