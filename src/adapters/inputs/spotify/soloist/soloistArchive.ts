import { gunzipSync } from 'node:zlib';

/** Every tar record is 512 bytes, header included. */
const BLOCK = 512;
const GZIP_MAGIC = [0x1f, 0x8b];

export function looksGzipped(buffer: Buffer): boolean {
  return buffer.length > 2 && buffer[0] === GZIP_MAGIC[0] && buffer[1] === GZIP_MAGIC[1];
}

/**
 * Pull the `soloist` program out of the archive Spotify publishes.
 *
 * What their download page hands you is a `.tar.gz`, which on Windows — and for anyone who would
 * rather not meet a terminal — is a step that has nothing to do with playing music. Unpacking it
 * here costs a few dozen lines and removes that entirely.
 *
 * Deliberately its own reader rather than a dependency or a shell-out to `tar`: one known file out
 * of one small archive needs none of what a tar library carries, and reading it here keeps it
 * testable without a filesystem.
 *
 * Returns null when the archive holds no such file, which is the case worth reporting — it usually
 * means the wrong thing was uploaded.
 */
export function extractSoloistFromArchive(archive: Buffer): Buffer | null {
  const tar = looksGzipped(archive) ? gunzipSync(archive) : archive;
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    // Two consecutive zero blocks end the archive; one is enough to know there is no more header.
    if (header.every((byte) => byte === 0)) {
      return null;
    }
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(readString(header, 124, 12).trim() || '0', 8);
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const isFile = typeFlag === '0' || typeFlag === '\0' || header[156] === 0;

    const dataStart = offset + BLOCK;
    if (isFile && basename(fullName) === 'soloist') {
      return tar.subarray(dataStart, dataStart + size);
    }
    // Payloads are padded out to the next record boundary.
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return null;
}

function readString(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

function basename(name: string): string {
  const parts = name.split('/');
  return parts[parts.length - 1] ?? name;
}
