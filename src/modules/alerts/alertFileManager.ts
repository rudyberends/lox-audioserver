import { resolve } from 'node:path';
import { copyFile, mkdir, stat, unlink, writeFile } from 'node:fs/promises';

export interface AlertFileInfo {
  id: string;
  filename: string;
  url: string;
  hasBackup: boolean;
}

export const ALERT_FILE_MAP: Record<string, string> = {
  alarm: 'alarm.mp3',
  firealarm: 'firealarm.mp3',
  bell: 'bell.mp3',
  buzzer: 'buzzer.mp3',
};

const ALERTS_DIR = resolve(process.cwd(), 'public', 'alerts');
const ALERTS_ORIGINAL_DIR = resolve(ALERTS_DIR, 'original');

export async function listAlertFiles(): Promise<AlertFileInfo[]> {
  const entries = Object.entries(ALERT_FILE_MAP);
  const items = await Promise.all(
    entries.map(async ([id, filename]) => {
      const hasBackup = await fileExists(resolve(ALERTS_ORIGINAL_DIR, filename));
      return {
        id,
        filename,
        url: `/alerts/${filename}`,
        hasBackup,
      };
    }),
  );
  return items;
}

export async function updateAlertFile(id: string, base64Data: string): Promise<void> {
  const filename = ALERT_FILE_MAP[id];
  if (!filename) {
    throw new Error('unknown-alert-id');
  }
  if (!base64Data) {
    throw new Error('missing-alert-data');
  }

  const buffer = Buffer.from(base64Data, 'base64');
  const dest = resolve(ALERTS_DIR, filename);
  const backup = resolve(ALERTS_ORIGINAL_DIR, filename);

  await ensureBackup(dest, backup);
  await mkdir(ALERTS_DIR, { recursive: true });
  await writeFile(dest, buffer);
}

export async function revertAlertFile(id: string): Promise<void> {
  const filename = ALERT_FILE_MAP[id];
  if (!filename) {
    throw new Error('unknown-alert-id');
  }
  const dest = resolve(ALERTS_DIR, filename);
  const backup = resolve(ALERTS_ORIGINAL_DIR, filename);
  const exists = await fileExists(backup);
  if (!exists) {
    throw new Error('no-alert-backup');
  }
  await mkdir(ALERTS_DIR, { recursive: true });
  await copyFile(backup, dest);
  await removeFile(backup);
}

async function ensureBackup(dest: string, backup: string): Promise<void> {
  try {
    const stats = await stat(dest);
    if (stats.isFile()) {
      await mkdir(ALERTS_ORIGINAL_DIR, { recursive: true });
      const hasBackup = await fileExists(backup);
      if (!hasBackup) {
        await copyFile(dest, backup);
      }
    }
  } catch {
    // destination missing → nothing to back up
  }
}

async function removeFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // ignore missing files
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}
