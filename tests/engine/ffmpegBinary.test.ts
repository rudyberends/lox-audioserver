import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from '../testHarness';
import { resolveFfmpegBinary, type ResolveFfmpegDeps } from '../../src/engine/ffmpegProcess';

/*
 * Which ffmpeg we spawn is not a detail: the bundled `ffmpeg-static` build is statically
 * linked, and a static glibc cannot dlopen the NSS modules that resolve hostnames. Every
 * stream URL that is not an IP literal dies there — on some hosts with a SIGSEGV before a
 * single log line (issue #336). A distribution ffmpeg does not have that problem and the
 * Docker image installs one, so the order below is the fix, and a regression that quietly
 * reinstated "bundled first" would break casting and radio again with nothing failing here
 * unless it is asserted.
 *
 * The counterweight is that a cut-down system build would trade a DNS failure for a missing
 * encoder, so it only wins once it has shown it can do what every output profile needs.
 */

const FULL_VERSION = [
  'ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers',
  'configuration: --enable-gpl --enable-libmp3lame --enable-libopus --enable-libsoxr',
].join('\n');

/** A PATH with one entry, holding a fully capable ffmpeg unless an override says otherwise. */
function deps(overrides: Partial<ResolveFfmpegDeps> & { version?: string | null }): ResolveFfmpegDeps {
  const systemPath = path.join('/usr/bin', 'ffmpeg');
  return {
    searchPath: '/usr/bin',
    isExecutable: (candidate) => candidate === systemPath,
    probeVersion: () => (overrides.version === undefined ? FULL_VERSION : overrides.version),
    bundled: '/app/node_modules/ffmpeg-static/ffmpeg',
    ...overrides,
  };
}

test('a capable system ffmpeg beats the bundled static build', () => {
  const choice = resolveFfmpegBinary(deps({}));
  assert.equal(choice.path, '/usr/bin/ffmpeg');
  assert.equal(choice.source, 'system');
});

test('a system ffmpeg missing an encoder we need is skipped for the bundled one', () => {
  const withoutOpus = FULL_VERSION.replace(' --enable-libopus', '');
  const choice = resolveFfmpegBinary(deps({ version: withoutOpus }));
  assert.equal(choice.path, '/app/node_modules/ffmpeg-static/ffmpeg');
  assert.equal(choice.source, 'bundled');
});

test('a system ffmpeg that will not run at all is skipped for the bundled one', () => {
  const choice = resolveFfmpegBinary(deps({ version: null }));
  assert.equal(choice.source, 'bundled');
});

test('no ffmpeg on PATH falls back to the bundled build', () => {
  const choice = resolveFfmpegBinary(deps({ isExecutable: () => false }));
  assert.equal(choice.path, '/app/node_modules/ffmpeg-static/ffmpeg');
  assert.equal(choice.source, 'bundled');
});

test('with neither a system nor a bundled ffmpeg, the name is left to PATH at spawn', () => {
  const choice = resolveFfmpegBinary(deps({ isExecutable: () => false, bundled: null }));
  assert.equal(choice.path, 'ffmpeg');
  assert.equal(choice.source, 'path-fallback');
});

test('PATH order decides between two system ffmpegs', () => {
  const probed: string[] = [];
  const choice = resolveFfmpegBinary(
    deps({
      searchPath: ['/usr/local/bin', '/usr/bin'].join(path.delimiter),
      isExecutable: () => true,
      probeVersion: (candidate) => {
        probed.push(candidate);
        return FULL_VERSION;
      },
    }),
  );
  assert.equal(choice.path, '/usr/local/bin/ffmpeg');
  assert.deepEqual(probed, ['/usr/local/bin/ffmpeg']);
});
