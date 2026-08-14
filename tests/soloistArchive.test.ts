import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { test } from './testHarness';
import {
  extractSoloistFromArchive,
  looksGzipped,
} from '../src/adapters/inputs/spotify/soloist/soloistArchive';

/**
 * Spotify publishes the program as a `.tar.gz`, so the upload takes one — unpacking it is a step
 * with nothing to do with playing music, and on Windows it is a real obstacle.
 */

const BLOCK = 512;

/** Build a tar the way the real one is shaped: the program inside a versioned directory. */
function tarWith(entries: Array<{ name: string; body: Buffer; type?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(BLOCK);
    header.write(entry.name, 0, 100, 'utf8');
    header.write('000644 \0', 100, 8, 'utf8');
    header.write(`${entry.body.length.toString(8).padStart(11, '0')} `, 124, 12, 'utf8');
    header.write(entry.type ?? '0', 156, 1, 'utf8');
    header.write('ustar\0', 257, 6, 'utf8');
    blocks.push(header);
    const padded = Buffer.alloc(Math.ceil(entry.body.length / BLOCK) * BLOCK);
    entry.body.copy(padded);
    blocks.push(padded);
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(blocks);
}

test('the program is found inside the archive Spotify publishes', () => {
  const program = Buffer.from('\x7fELF-not-really-but-distinctive');
  const archive = gzipSync(
    tarWith([
      { name: 'soloist-1.3.7/', body: Buffer.alloc(0), type: '5' },
      { name: 'soloist-1.3.7/README.md', body: Buffer.from('read me') },
      { name: 'soloist-1.3.7/soloist', body: program },
    ]),
  );
  assert.equal(looksGzipped(archive), true);
  assert.deepEqual(extractSoloistFromArchive(archive), program);
});

test('a plain tar works too, so an already-unpacked archive is not refused', () => {
  const program = Buffer.from('the program');
  const archive = tarWith([{ name: 'soloist', body: program }]);
  assert.equal(looksGzipped(archive), false);
  assert.deepEqual(extractSoloistFromArchive(archive), program);
});

test('an archive without the program says so instead of storing something else', () => {
  const archive = gzipSync(tarWith([{ name: 'notes.txt', body: Buffer.from('nothing here') }]));
  assert.equal(extractSoloistFromArchive(archive), null);
});

test('a raw program is not mistaken for an archive', () => {
  // The upload accepts both, and the only thing separating them is the gzip magic.
  assert.equal(looksGzipped(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02])), false);
});
