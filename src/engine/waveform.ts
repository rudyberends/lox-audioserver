/**
 * The shape of a whole track, computed before it is heard.
 *
 * The player's timeline drew the envelope of what it had *listened to* — a record of the session,
 * honest but half a picture: open a track at 2:00 and the first two minutes are a flat line forever.
 * This is the other half. One decode pass over the file gives the whole shape up front, so the
 * timeline arrives complete and the playhead moves across a waveform instead of drawing one.
 *
 * Only files. A streaming service hands over its audio while you play it, so there is nothing to
 * scan in advance without downloading the track first — those keep the live envelope, and that
 * boundary is worth stating to a caller rather than papering over.
 *
 * Deliberately cheap. ffmpeg decodes straight to 4 kHz mono, which is two orders of magnitude less
 * data than the source and plenty for a few hundred buckets: measured at 0.85 s for a 137-second
 * 192 kHz/24-bit FLAC (95 MB) on a two-core ARM box, and well under that for anything smaller.
 * Resampling that far down is not a quality decision — nothing here is played — it is what keeps a
 * whole-file pass affordable on the hardware this runs on.
 */
import { spawn } from 'node:child_process';
import { FFMPEG_BINARY } from '@/engine/ffmpegProcess';
import { ANALYSIS_DB_FLOOR } from '@/application/audio/audioAnalysisService';
import { createLogger } from '@/shared/logging/logger';

const log = createLogger('Engine', 'Waveform');

/** Buckets per track. 400 is ~3 px each on a wide display and 400 bytes stored. */
export const WAVEFORM_BUCKETS = 400;

/** The rate the file is decoded to. Only bucket energy is wanted, never playback. */
export const PROBE_RATE = 4000;

/**
 * How much decoded audio to hold before giving up.
 *
 * At 4 kHz mono 16-bit that is 8 kB per second, so this is a little over three hours — far past any
 * track and short of letting a mislabelled file (a whole concert in one wav) eat the heap.
 */
const MAX_BYTES = 96 * 1024 * 1024;

/** How long a single decode may take before it is killed. A slow disk is not worth blocking on. */
const TIMEOUT_MS = 60_000;

export type Waveform = {
  /** One byte per bucket: the bucket's level as a position in [ANALYSIS_DB_FLOOR, 0] dB, 0…255. */
  buckets: Uint8Array;
  /** Decoded length in ms, which is the file's real duration rather than a tag's claim. */
  durationMs: number;
};

/**
 * The same dB mapping the realtime analyser uses, at byte resolution.
 *
 * Sharing the scale is the point: a prepared waveform and the live one are drawn by the same client
 * with the same maths, so a track whose envelope was computed here and one that is being recorded as
 * it plays cannot end up looking like different measurements of different things.
 */
function levelToByte(rms: number): number {
  if (rms <= 0) {
    return 0;
  }
  const db = 20 * Math.log10(rms);
  const norm = Math.max(0, Math.min(1, (db - ANALYSIS_DB_FLOOR) / -ANALYSIS_DB_FLOOR));
  return Math.round(norm * 255);
}

/**
 * Reduce decoded mono 16-bit PCM to `WAVEFORM_BUCKETS` levels.
 *
 * Separate from the decode so the encoding can be tested without an ffmpeg: what a byte *means* is
 * the contract the player draws against, and it is worth pinning against tones of a known level
 * rather than against whatever this currently produces.
 */
export function bucketsFromPcm(pcm: Buffer): Uint8Array {
  const samples = Math.floor(pcm.length / 2);
  const perBucket = Math.max(1, Math.floor(samples / WAVEFORM_BUCKETS));
  const buckets = new Uint8Array(WAVEFORM_BUCKETS);
  for (let b = 0; b < WAVEFORM_BUCKETS; b += 1) {
    const from = b * perBucket;
    const to = Math.min(samples, from + perBucket);
    if (from >= to) {
      break;
    }
    let sumSq = 0;
    for (let i = from; i < to; i += 1) {
      const v = pcm.readInt16LE(i * 2) / 32768;
      sumSq += v * v;
    }
    buckets[b] = levelToByte(Math.sqrt(sumSq / (to - from)));
  }
  return buckets;
}

/**
 * Decode `path` and reduce it to `WAVEFORM_BUCKETS` levels, or null when it cannot be read.
 *
 * Null rather than throwing: a waveform is an enhancement, and a file that ffmpeg dislikes should
 * cost the caller a missing picture and nothing else.
 */
export async function computeWaveform(path: string): Promise<Waveform | null> {
  const started = Date.now();
  const chunks: Buffer[] = [];
  let total = 0;

  const pcm = await new Promise<Buffer | null>((resolve) => {
    const proc = spawn(
      FFMPEG_BINARY,
      // `-vn` because an embedded cover is a video stream, and `-map 0:a:0` so a file with several
      // audio tracks is reduced by its first rather than refused.
      ['-v', 'error', '-i', path, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', String(PROBE_RATE), '-f', 's16le', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    const timer = setTimeout(() => {
      log.warn('waveform decode timed out', { path, ms: TIMEOUT_MS });
      proc.kill('SIGKILL');
    }, TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BYTES) {
        log.warn('waveform decode exceeded the byte cap', { path, total });
        proc.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      log.warn('waveform decode failed to start', { path, message: error.message });
      resolve(null);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        log.warn('waveform decode failed', { path, code, stderr: stderr.trim().slice(0, 200) });
        resolve(null);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });

  if (!pcm || pcm.length < 2) {
    return null;
  }

  const samples = Math.floor(pcm.length / 2);
  const buckets = bucketsFromPcm(pcm);

  const durationMs = Math.round((samples / PROBE_RATE) * 1000);
  log.debug('waveform computed', { path, durationMs, ms: Date.now() - started });
  return { buckets, durationMs };
}
