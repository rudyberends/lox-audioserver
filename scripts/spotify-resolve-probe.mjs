#!/usr/bin/env node
// Validation harness for the resolveAudioFile -> CDN fetch -> AES-128-CTR
// decrypt -> Ogg-strip chain, BEFORE wiring it into the playback flow.
//
// This exercises exactly what the production Spotify stream proxy will do, so
// the decrypt/strip logic here ports 1:1 into a Transform stream once verified.
//
// Usage:
//   SPOTIFY_ACCESS_TOKEN=<web-api-token> \
//   node scripts/spotify-resolve-probe.mjs spotify:track:<id> [bitrate]
//
// Requires: a Spotify Web API access token (the running server has no account
// logged in yet, so we pass one explicitly). clientId is read from data/config.json.
// Writes /tmp/spotify-probe.ogg and runs ffprobe to confirm it decodes.

import { createSession, setLogLevel } from '@sonn-audio/node-librespot';
import { createDecipheriv } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// librespot's fixed AES-128-CTR audio IV (initial counter block).
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
const accessToken = process.env.SPOTIFY_ACCESS_TOKEN;
if (!accessToken) die('set SPOTIFY_ACCESS_TOKEN (Spotify Web API access token)');

let clientId;
try {
  clientId = JSON.parse(readFileSync(new URL('../data/config.json', import.meta.url))).content?.spotify?.clientId;
} catch {
  /* optional */
}

setLogLevel('warn');

const t0 = Date.now();
const session = await createSession({ accessToken, clientId, deviceName: 'resolve-probe' });
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

// AES-128-CTR decrypt from offset 0 (single stream; CTR auto-increments).
const decipher = createDecipheriv('aes-128-ctr', key, AUDIO_AES_IV);
let decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

const isOgg = /OGG/i.test(resolved.format);
if (isOgg) {
  const oggStart = decrypted.indexOf(OGG_MAGIC);
  if (oggStart < 0) die('no OggS page found after decrypt — wrong key/IV?');
  console.log(`• stripped ${oggStart} byte header (OggS at offset ${oggStart})`);
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
