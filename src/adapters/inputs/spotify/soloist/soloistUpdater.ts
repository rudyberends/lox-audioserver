import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@/shared/logging/logger';
import {
  extractSoloistFromArchive,
  looksGzipped,
} from '@/adapters/inputs/spotify/soloist/soloistArchive';
import { soloistBinaryPath } from '@/adapters/inputs/spotify/soloist/soloistProcess';

const log = createLogger('Input', 'SoloistUpdate');

/**
 * Where Spotify publishes Soloist, one archive per architecture.
 *
 * Plain files on their CDN, with no account and no cookie. That is what makes this possible at all
 * — a build expires every 90 days, and expecting someone to notice that and go fetch a new one by
 * hand is expecting them to remember a chore with no reminder.
 *
 * Note what this is not: the program is never shipped with this server. Spotify does not allow
 * that, and nothing here does it — the machine that will run it fetches its own copy, from
 * Spotify, over TLS. Keep it that way.
 */
const BUILD_URLS: Record<string, string> = {
  arm64: 'https://soloist-builds.spotifycdn.com/soloist_release_arm64.tar.gz',
  x64: 'https://soloist-builds.spotifycdn.com/soloist_release_x86_64.tar.gz',
  arm: 'https://soloist-builds.spotifycdn.com/soloist_release_arm32.tar.gz',
};

/** A build is around 13 MB; well past that and something other than a build is being served. */
const MAX_BUILD_BYTES = 64 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 120_000;
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
/** `e_machine` values, for checking a build against the machine it will run on. */
const ELF_MACHINES: Record<number, string> = { 0x28: 'arm', 0x3e: 'x64', 0xb7: 'arm64' };

export type BuildUpdate =
  | { status: 'installed'; signature?: string; digest: string; bytes: number }
  | { status: 'unchanged'; signature?: string }
  | { status: 'unsupported-arch'; arch: string }
  | { status: 'failed'; message: string };

/**
 * What identifies a build, since its etag does not.
 *
 * Measured: the CDN answers `If-None-Match` with 200 whatever you send it, and hands out a
 * different etag for a HEAD than for a GET — so conditional requests are no use here. What it does
 * report consistently is when the file was published and how large it is, and that is enough to
 * know whether to spend thirteen megabytes finding out more.
 */
function signatureOf(headers: Headers): string | undefined {
  const modified = headers.get('last-modified');
  const length = headers.get('content-length');
  return modified || length ? `${modified ?? ''}|${length ?? ''}` : undefined;
}

export function buildUrlForHost(): string | null {
  return BUILD_URLS[process.arch] ?? null;
}

/**
 * Fetch the current build unless we already have it.
 *
 * `known` is what was installed last time. The daily check is a HEAD — a couple of hundred bytes —
 * and only a file that says it changed is worth downloading.
 */
export async function fetchBuild(known?: { signature?: string; digest?: string }): Promise<BuildUpdate> {
  const url = buildUrlForHost();
  if (!url) {
    return { status: 'unsupported-arch', arch: process.arch };
  }
  try {
    if (known?.signature) {
      const head = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      }).catch(() => null);
      if (head?.ok && signatureOf(head.headers) === known.signature) {
        return { status: 'unchanged', signature: known.signature };
      }
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!response.ok) {
      return { status: 'failed', message: `spotify answered ${response.status}` };
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_BUILD_BYTES) {
      return { status: 'failed', message: `build is ${length} bytes, which is not a build` };
    }
    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.length > MAX_BUILD_BYTES) {
      return { status: 'failed', message: 'build is larger than anything a build should be' };
    }
    const program = looksGzipped(archive) ? extractSoloistFromArchive(archive) : archive;
    if (!program) {
      return { status: 'failed', message: 'the archive held no soloist' };
    }
    if (!program.subarray(0, 4).equals(ELF_MAGIC)) {
      return { status: 'failed', message: 'what came back is not a program' };
    }
    const machine = ELF_MACHINES[program.readUInt16LE(18)];
    if (machine && machine !== process.arch) {
      // Should never happen — the url is chosen by architecture — but installing a program that
      // cannot run here would break playback in a way that looks like anything but a bad download.
      return { status: 'failed', message: `build is for ${machine}, this is ${process.arch}` };
    }

    // Even a file that says it changed may be the same program — the CDN's own metadata moves
    // about. Comparing what is inside is what keeps a room from restarting for nothing.
    const digest = createHash('sha256').update(program).digest('hex');
    const signature = signatureOf(response.headers);
    if (known?.digest && digest === known.digest) {
      return { status: 'unchanged', signature };
    }

    const target = soloistBinaryPath();
    await fsp.mkdir(path.dirname(target), { recursive: true });
    // Write beside it and move into place: a half-written program is worse than an expired one,
    // and a rename is the only way to replace a file nobody may catch mid-swap.
    const staging = `${target}.new`;
    await fsp.writeFile(staging, program, { mode: 0o700 });
    await fsp.rename(staging, target);
    log.info('installed a new soloist build', { bytes: program.length, signature });
    return { status: 'installed', signature, digest, bytes: program.length };
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
