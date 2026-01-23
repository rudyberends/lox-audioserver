import path from 'node:path';
import { parseFile } from 'music-metadata';
import { ALERT_FILE_MAP } from '@/application/alerts/alertFileManager';
import type { AlertMediaResource } from '@/application/alerts/types';
import { createLogger } from '@/shared/logging/logger';

const ALERTS_DIR = path.resolve(process.cwd(), 'public', 'alerts');
const LOOPING_ALERT_TYPES = new Set(['alarm', 'firealarm']);

export class FileAlertProvider {
  private readonly log = createLogger('Alerts', 'FileProvider');
  private readonly durationCache = new Map<string, number>();

  public async resolve(type: string): Promise<AlertMediaResource | undefined> {
    const filename = ALERT_FILE_MAP[type];
    if (!filename) {
      return undefined;
    }
    const shouldLoop = LOOPING_ALERT_TYPES.has(type.toLowerCase());
    return this.buildResource(filename, type, shouldLoop);
  }

  public async resolveUploaded(filename: string): Promise<AlertMediaResource | undefined> {
    if (!filename) {
      return undefined;
    }
    const relativePath = `cache/${filename}`;
    return this.buildResource(relativePath, filename);
  }

  private async buildResource(
    relativePath: string,
    title: string,
    loop = false,
  ): Promise<AlertMediaResource | undefined> {
    const encodedPath = encodeAlertPath(relativePath);
    const url = `${loop ? 'alerts-loop' : 'alerts'}://${encodedPath}`;
    const duration = loop ? undefined : await this.resolveDuration(relativePath);

    return {
      title,
      relativePath,
      url,
      loop: loop || undefined,
      duration,
    };
  }

  private async resolveDuration(relativePath: string): Promise<number | undefined> {
    if (this.durationCache.has(relativePath)) {
      return this.durationCache.get(relativePath);
    }
    const parts = relativePath.split('/').map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
    const abs = path.resolve(ALERTS_DIR, ...parts);
    try {
      const meta = await parseFile(abs);
      const duration = meta.format.duration;
      if (typeof duration === 'number' && duration > 0) {
        const rounded = Math.round(duration);
        this.durationCache.set(relativePath, rounded);
        return rounded;
      }
    } catch (err) {
      this.log.debug('alert duration probe failed', {
        path: abs,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return undefined;
  }
}

function encodeAlertPath(relative: string): string {
  return relative
    .split(/[\\/]/)
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
