import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type YtDlpExecOptions = {
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
};

/** Why the run ended: it never started, it outlived its timeout, or yt-dlp itself said no. */
export type YtDlpFailure = 'spawn' | 'timeout' | 'exit';

export class YtDlpError extends Error {
  public readonly exitCode: number | null;
  public readonly stderr: string;
  public readonly failure: YtDlpFailure;
  constructor(message: string, opts: { exitCode: number | null; stderr?: string; failure?: YtDlpFailure }) {
    super(message);
    this.exitCode = opts.exitCode;
    this.stderr = opts.stderr ?? '';
    this.failure = opts.failure ?? 'exit';
  }
}

export async function runYtDlpJson(
  args: string[],
  options?: YtDlpExecOptions,
): Promise<any> {
  const { stdout } = await runYtDlp(args, options);
  return parseSingleJson(stdout);
}

export async function runYtDlpJsonLines(
  args: string[],
  options?: YtDlpExecOptions,
): Promise<any[]> {
  const { stdout } = await runYtDlp(args, options);
  return parseJsonLines(stdout);
}

export async function runYtDlp(
  args: string[],
  options?: YtDlpExecOptions,
): Promise<{ stdout: string; stderr: string }> {
  const ytDlpPath = 'yt-dlp';
  const timeoutMs = typeof options?.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 20_000;
  try {
    const res = await execFileAsync(ytDlpPath, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 20,
      env: { ...process.env, ...(options?.env ?? {}) },
    });
    return { stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') };
  } catch (err: unknown) {
    const e = err as { stderr?: unknown; code?: unknown; killed?: unknown } | null;
    const stderr = String(e?.stderr ?? '');
    const code = typeof e?.code === 'number' ? e.code : null;

    // Three very different problems used to share one message. A run that never
    // started (yt-dlp absent, or its python3 interpreter absent — a missing
    // interpreter fails the exec the same ENOENT way) and a run killed at the
    // timeout both arrive with no numeric exit code, so "yt-dlp failed" was the
    // whole report for both, and told a user nothing about which to go fix.
    if (e?.code === 'ENOENT') {
      throw new YtDlpError(
        `yt-dlp could not be started: '${ytDlpPath}' not found (or its interpreter is missing)`,
        { exitCode: null, stderr, failure: 'spawn' },
      );
    }
    if (e?.killed === true) {
      throw new YtDlpError(`yt-dlp timed out after ${timeoutMs} ms`, {
        exitCode: null,
        stderr,
        failure: 'timeout',
      });
    }

    const message = `yt-dlp failed${code !== null ? ` (code ${code})` : ''}`;
    throw new YtDlpError(message, { exitCode: code, stderr, failure: 'exit' });
  }
}

export function parseJsonLines(stdout: string): any[] {
  const lines = String(stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const out: any[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // ignore non-JSON lines
    }
  }
  return out;
}

export function parseSingleJson(stdout: string): any | null {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return null;
  // yt-dlp can print multiple JSON lines; prefer the last parseable one.
  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i] ?? '');
    } catch {
      /* continue */
    }
  }
  return null;
}

export function buildYtMusicSearchUrl(query: string): string {
  const q = String(query || '').trim();
  const url = new URL('https://music.youtube.com/search');
  url.searchParams.set('q', q);
  return url.toString();
}

export function buildYtMusicWatchUrl(videoId: string): string {
  const id = String(videoId || '').trim();
  const url = new URL('https://music.youtube.com/watch');
  url.searchParams.set('v', id);
  return url.toString();
}

export function buildYtMusicPlaylistUrl(playlistId: string): string {
  const id = String(playlistId || '').trim();
  const url = new URL('https://music.youtube.com/playlist');
  url.searchParams.set('list', id);
  return url.toString();
}

export function buildYtMusicBrowseUrl(browseId: string): string {
  const id = String(browseId || '').trim();
  // The `browse` endpoint is used for albums/artists/etc.
  return `https://music.youtube.com/browse/${encodeURIComponent(id)}`;
}

export function extractVideoId(value: string): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  // YouTube video ids are 11 chars. Treat anything else as not a video id, otherwise
  // browse/playlist ids like "VL..." get misclassified as tracks.
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw) && !raw.includes('://')) {
    return raw;
  }
  try {
    const url = new URL(raw);
    const v = url.searchParams.get('v');
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
    // ytmusic://track/<id> or similar: last path segment.
    const parts = url.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && /^[a-zA-Z0-9_-]{11}$/.test(last)) return last;
  } catch {
    /* ignore */
  }
  return null;
}

export function extractPlaylistId(value: string): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^[a-zA-Z0-9_-]{4,}$/.test(raw) && !raw.includes('://')) {
    return raw;
  }
  try {
    const url = new URL(raw);
    const list = url.searchParams.get('list');
    if (list) return list;
  } catch {
    /* ignore */
  }
  return null;
}

export function extractBrowseId(value: string): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^[A-Za-z0-9_-]{6,}$/.test(raw) && !raw.includes('://')) {
    return raw;
  }
  try {
    const url = new URL(raw);
    const parts = url.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex((p) => p.toLowerCase() === 'browse');
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1]!;
  } catch {
    /* ignore */
  }
  return null;
}
