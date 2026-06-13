#!/usr/bin/env node
// Like spotify-resolve-probe.mjs, but authenticates with the stored librespot
// credentials blob (data/config.json -> content.spotify.accounts[].librespotCredentials)
// via createSessionWithCredentials() — exactly what the production stream proxy
// uses — instead of a Web API access token.
//
// Usage:
//   node scripts/spotify-resolve-probe-creds.mjs spotify:track:<id> [bitrate]
//
// Writes /tmp/spotify-probe.ogg, prints the first 64 decrypted bytes as hex,
// and runs ffprobe to confirm it decodes.

import pkg from '@lox-audioserver/node-librespot';
import { createDecipheriv } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const { createSessionWithCredentials, setLogLevel } = pkg;

const AUDIO_AES_IV = Buffer.from([
  0x72, 0xe0, 0x67, 0xfb, 0xdd, 0xcb, 0xcf, 0x77,
  0xeb, 0xe8, 0xbc, 0x64, 0x3f, 0x63, 0x0d, 0x93,
]);
const OGG_MAGIC = Buffer.from('OggS', 'ascii');

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const uri = process.argv[2];
const bitrate = Number(process.argv[3] || 320);
if (!uri || !uri.startsWith('spotify:')) {
  die('pass a spotify URI, e.g. spotify:track:4uLU6hMCjMI75M1A2tKUQC');
}

const cfg = JSON.parse(readFileSync(new URL('../data/config.json', import.meta.url)));
const account = cfg.content?.spotify?.accounts?.[0];
const creds = account?.librespotCredentials;
if (!creds) die('no librespotCredentials in data/config.json');
console.log(`• using stored credentials for account "${account.user}"`);

setLogLevel?.('warn');

const t0 = Date.now();
const session = await createSessionWithCredentials(JSON.stringify(creds), 'resolve-probe', null, null);
if (!session) die('createSessionWithCredentials returned null');
console.log(`• session created (${Date.now() - t0}ms)`);

const resolved = session.resolveAudioFile({ uri, bitrate });
console.log('• resolveAudioFile ->', {
  format: resolved.format,
  keyHex: `${resolved.keyHex.slice(0, 8)}… (${resolved.keyHex.length} chars)`,
  cdnUrl: `${resolved.cdnUrl.slice(0, 80)}…`,
});

const key = Buffer.from(resolved.keyHex, 'hex');
if (key.length !== 16) die(`expected 16-byte key, got ${key.length}`);

const tFetch = Date.now();
const res = await fetch(resolved.cdnUrl);
if (!res.ok) die(`CDN fetch failed: ${res.status}`);
const encrypted = Buffer.from(await res.arrayBuffer());
console.log(`• fetched ${encrypted.length} encrypted bytes (${Date.now() - tFetch}ms)`);

const decipher = createDecipheriv('aes-128-ctr', key, AUDIO_AES_IV);
let decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

console.log(`• first 64 decrypted bytes: ${decrypted.subarray(0, 64).toString('hex')}`);

const SPOTIFY_OGG_HEADER_END = 0xa7;
const isOgg = /OGG/i.test(resolved.format);
if (isOgg) {
  // Mirror the production fix: skip Spotify's fixed 0xa7 placeholder header and
  // align to the real Vorbis BOS page (search for OggS starting AFTER 0xa7).
  const oggStart = decrypted.indexOf(OGG_MAGIC, SPOTIFY_OGG_HEADER_END);
  if (oggStart < 0) die('no real OggS page found after 0xa7 — wrong key/IV?');
  console.log(`• real OggS at offset ${oggStart} (placeholder at offset ${decrypted.indexOf(OGG_MAGIC)})`);
  decrypted = decrypted.subarray(oggStart);
}

const out = '/tmp/spotify-probe.ogg';
writeFileSync(out, decrypted);
console.log(`• wrote ${decrypted.length} bytes -> ${out}`);

const probe = spawnSync('ffprobe', [
  '-v', 'error',
  '-show_entries', 'format=duration,format_name:stream=codec_name,sample_rate,channels',
  '-of', 'default=noprint_wrappers=1',
  out,
], { encoding: 'utf8' });

if (probe.status !== 0) {
  console.error(probe.stderr || probe.error?.message);
  die('ffprobe rejected the decoded file — decrypt/strip likely wrong');
}
console.log('✓ ffprobe OK:\n' + probe.stdout.trim().split('\n').map((l) => `    ${l}`).join('\n'));
await session.close();
console.log('✓ chain validated end-to-end');
