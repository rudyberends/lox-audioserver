#!/usr/bin/env node
// Measures how long session.resolveAudioFile() blocks the Node event loop.
// The binding does block_on(CDN url + key lookup) synchronously on the main
// thread, so this is the regression risk vs the warm librespot pipe: during a
// track start every OTHER zone's pacing/IO callbacks are stalled.
//
// Method: run a 5ms setInterval ticker; the largest gap between ticks that
// straddles a resolveAudioFile() call is the event-loop stall it caused.
//
// Usage: node scripts/spotify-resolve-bench.mjs spotify:track:<id> [iterations]

import pkg from '@sonn-audio/node-librespot';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const { createSessionWithCredentials, setLogLevel } = pkg;

const uri = process.argv[2] || 'spotify:track:2j9BshApYO0RP5arxCAQ7W';
const iterations = Number(process.argv[3] || 5);

const cfg = JSON.parse(readFileSync(new URL('../data/config.json', import.meta.url)));
const creds = cfg.content?.spotify?.accounts?.[0]?.librespotCredentials;
if (!creds) {
  console.error('no librespotCredentials in data/config.json');
  process.exit(1);
}

setLogLevel?.('warn');
const session = await createSessionWithCredentials(JSON.stringify(creds), 'resolve-bench', null, null);
if (!session) {
  console.error('createSessionWithCredentials returned null');
  process.exit(1);
}

// Event-loop lag ticker.
let lastTick = performance.now();
let maxGap = 0;
const TICK_MS = 5;
const ticker = setInterval(() => {
  const now = performance.now();
  const gap = now - lastTick;
  if (gap > maxGap) maxGap = gap;
  lastTick = now;
}, TICK_MS);
ticker.unref?.();

const blockTimes = [];
const loopStalls = [];
for (let i = 0; i < iterations; i++) {
  // let the ticker settle
  await new Promise((r) => setTimeout(r, 200));
  maxGap = 0;
  lastTick = performance.now();
  const t0 = performance.now();
  const useAsync = process.env.ASYNC === '1';
  const resolved = useAsync
    ? await session.resolveAudioFileAsync({ uri, bitrate: 320 })
    : session.resolveAudioFile({ uri, bitrate: 320 });
  const blockMs = performance.now() - t0;
  // give the ticker one more cycle to record the straddling gap
  await new Promise((r) => setTimeout(r, 50));
  blockTimes.push(blockMs);
  loopStalls.push(maxGap);
  console.log(
    `iter ${i + 1}: resolveAudioFile returned in ${blockMs.toFixed(1)}ms ` +
    `| max event-loop gap ${maxGap.toFixed(1)}ms | format ${resolved.format}`,
  );
}

clearInterval(ticker);
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const max = (a) => Math.max(...a);
console.log('');
console.log(`resolveAudioFile() blocking time : avg ${avg(blockTimes).toFixed(1)}ms  max ${max(blockTimes).toFixed(1)}ms`);
console.log(`event-loop stall (ticker gap)    : avg ${avg(loopStalls).toFixed(1)}ms  max ${max(loopStalls).toFixed(1)}ms  (baseline ~${TICK_MS}ms)`);
await session.close();
