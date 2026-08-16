import { spawn } from 'node:child_process';
import { createLogger } from '@/shared/logging/logger';
import { ffmpegBinary } from '@/engine/ffmpegProcess';

const DURATION_PROBE_TIMEOUT_MS = 30000;

const log = createLogger('Alerts', 'Duration');

/** Memoized per absolute path; alert clips are written once and then only read. */
const durationCache = new Map<string, number>();

/**
 * Resolve the playable length of an alert clip in whole seconds, or `undefined`
 * when it cannot be determined.
 *
 * Every alert source funnels through here — bundled files, uploads, and the
 * clips synthesized by the TTS providers — so the stop timer is fed by one
 * measurement method regardless of where the audio came from.
 */
export async function probeAlertDurationSeconds(absPath: string): Promise<number | undefined> {
  const cached = durationCache.get(absPath);
  if (cached !== undefined) {
    return cached;
  }
  const seconds = await decodeDurationSeconds(absPath);
  if (typeof seconds === 'number' && seconds > 0) {
    const rounded = Math.round(seconds);
    durationCache.set(absPath, rounded);
    log.debug('alert duration probed', { path: absPath, durationSec: rounded });
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
 * actually plays out, which is exactly what the stop timer needs. The same trap is open to
 * any TTS backend that answers in wav or opus, which is why they share this probe.
 *
 * `-vn` because cover art is a video stream of one frame at t=0, and the position ffmpeg
 * reports is the *earliest* of its outputs: with the picture mapped, `bell.mp3` measured
 * 0.00 s instead of 3.48 s. A zero-length probe falls back to `MIN_ALERT_DURATION_MS`, so
 * the doorbell held the zone for 20 seconds and the music came back long after the ring.
 */
function decodeDurationSeconds(absPath: string): Promise<number | undefined> {
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
      log.debug('alert duration probe failed', {
        path: absPath,
        message: err instanceof Error ? err.message : String(err),
      });
      finish(undefined);
    });
    proc.on('exit', () => finish(lastSeconds));
  });
}
