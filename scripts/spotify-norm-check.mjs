#!/usr/bin/env node
// Verify the loudness-normalisation parse + AES-CTR block-IV math:
// the ranged 16-byte decrypt (offset 144, counter block 9) must equal the same
// bytes obtained by decrypting the whole file from block 0.
//
// Usage: node scripts/spotify-norm-check.mjs spotify:track:<id>

import pkg from '@lox-audioserver/node-librespot';
import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';

const { createSessionWithCredentials, setLogLevel } = pkg;
const AUDIO_AES_IV = Buffer.from([
  0x72, 0xe0, 0x67, 0xfb, 0xdd, 0xcb, 0xcf, 0x77,
  0xeb, 0xe8, 0xbc, 0x64, 0x3f, 0x63, 0x0d, 0x93,
]);
const OFFSET = 144;

function ctrIvForBlock(base, blockIndex) {
  if (blockIndex <= 0) return Buffer.from(base);
  const mask = (1n << 128n) - 1n;
  const v = (BigInt('0x' + base.toString('hex')) + BigInt(blockIndex)) & mask;
  return Buffer.from(v.toString(16).padStart(32, '0'), 'hex');
}

const uri = process.argv[2] || 'spotify:track:2j9BshApYO0RP5arxCAQ7W';
const creds = JSON.parse(readFileSync(new URL('../data/config.json', import.meta.url)))
  .content?.spotify?.accounts?.[0]?.librespotCredentials;
setLogLevel?.('warn');
const session = await createSessionWithCredentials(JSON.stringify(creds), 'norm-check', null, null);
const resolved = session.resolveAudioFile({ uri, bitrate: 320 });
const key = Buffer.from(resolved.keyHex, 'hex');

// 1) full decrypt, read floats at 144
const full = Buffer.from(await (await fetch(resolved.cdnUrl)).arrayBuffer());
const dec = createDecipheriv('aes-128-ctr', key, AUDIO_AES_IV);
const plainFull = Buffer.concat([dec.update(full), dec.final()]);
const fTrackGain = plainFull.readFloatLE(OFFSET);
const fTrackPeak = plainFull.readFloatLE(OFFSET + 4);

// 2) ranged 16-byte decrypt at block 9
const enc = Buffer.from(await (await fetch(resolved.cdnUrl, { headers: { Range: `bytes=${OFFSET}-${OFFSET + 15}` } })).arrayBuffer());
const dec2 = createDecipheriv('aes-128-ctr', key, ctrIvForBlock(AUDIO_AES_IV, OFFSET / 16));
const plainRange = Buffer.concat([dec2.update(enc), dec2.final()]);
const rTrackGain = plainRange.readFloatLE(0);
const rTrackPeak = plainRange.readFloatLE(4);

const clipHeadroomDb = fTrackPeak > 0 ? -20 * Math.log10(fTrackPeak) : 0;
const appliedDb = Math.min(fTrackGain, clipHeadroomDb);

console.log('full  : trackGainDb=%s trackPeak=%s', fTrackGain.toFixed(3), fTrackPeak.toFixed(4));
console.log('ranged: trackGainDb=%s trackPeak=%s', rTrackGain.toFixed(3), rTrackPeak.toFixed(4));
console.log('match : %s', fTrackGain === rTrackGain && fTrackPeak === rTrackPeak ? 'YES ✓' : 'NO ✗');
console.log('applied gain (clip-safe): %sdB', appliedDb.toFixed(2));
await session.close();
