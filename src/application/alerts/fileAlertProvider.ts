import { spawn } from 'node:child_process';
import path from 'node:path';
import { ALERT_FILE_MAP } from '@/application/alerts/alertFileManager';
import type { AlertMediaResource } from '@/application/alerts/types';
import { createLogger } from '@/shared/logging/logger';
import { ffmpegBinary } from '@/engine/ffmpegProcess';

const DURATION_PROBE_TIMEOUT_MS = 30000;

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
    const relativePath = normalizeAlertRelativePath(`cache/${filename}`);
    if (!relativePath) {
      return undefined;
    }
    return this.buildResource(relativePath, filename);
  }

  public async resolveRelative(relativePath: string, title?: string): Promise<AlertMediaResource | undefined> {
    const normalized = normalizeAlertRelativePath(relativePath);
    if (!normalized) {
      return undefined;
    }
    const fallbackTitle = normalized.split('/').pop() ?? normalized;
    return this.buildResource(normalized, title ?? fallbackTitle);
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
    if (!abs.startsWith(ALERTS_DIR)) {
      return undefined;
    }
    const duration = await this.probeDurationSeconds(abs);
    if (typeof duration === 'number' && duration > 0) {
      const rounded = Math.round(duration);
      this.durationCache.set(relativePath, rounded);
      this.log.debug('alert duration probed', { path: abs, durationSec: rounded });
      return rounded;
    }
    return undefined;
  }

  /**
   * Measure the true playable duration by decoding the file to null and reading ffmpeg's
   * final reported position, instead of trusting the container header.
   *
   * Loxone voice recordings carry a WAV `data` chunk size that under-reports the real length;
   * a header parser (music-metadata) then returned e.g. 18 s for a 30 s clip, so the alert
   * stop timer fired early and clipped the recording on Sonos (#276). Decoding reports what
   * actually plays out, which is exactly what the stop timer needs.
   *
   * `-vn` because cover art is a video stream of one frame at t=0, and the position ffmpeg
   * reports is the *earliest* of its outputs: with the picture mapped, `bell.mp3` measured
   * 0.00 s instead of 3.48 s. A zero-length probe falls back to `MIN_ALERT_DURATION_MS`, so
   * the doorbell held the zone for 20 seconds and the music came back long after the ring.
   */
  private probeDurationSeconds(absPath: string): Promise<number | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      let lastSeconds: number | undefined;
      const finish = (value: number | undefined): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const proc = spawn(ffmpegBinary(), ['-hide_banner', '-i', absPath, '-vn', '-f', 'null', '-'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        finish(lastSeconds);
      }, DURATION_PROBE_TIMEOUT_MS);
      timer.unref?.();
      // ffmpeg reports the running output position on stderr as `time=HH:MM:SS.ss`; the final
      // line carries the true total once decoding reaches EOF.
      proc.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        const re = /time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(text)) !== null) {
          const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
          if (Number.isFinite(seconds) && seconds >= 0) {
            lastSeconds = seconds;
          }
        }
      });
      proc.on('error', (err) => {
        this.log.debug('alert duration probe failed', {
          path: absPath,
          message: err instanceof Error ? err.message : String(err),
        });
        finish(undefined);
      });
      proc.on('exit', () => finish(lastSeconds));
    });
  }
}

function encodeAlertPath(relative: string): string {
  return relative
    .split(/[\\/]/)
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function normalizeAlertRelativePath(input: string): string | null {
  if (!input?.trim()) {
    return null;
  }
  const parts = input
    .split(/[\\/]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!parts.length) {
    return null;
  }
  if (parts.some((segment) => segment === '.' || segment === '..')) {
    return null;
  }
  return parts.join('/');
}
