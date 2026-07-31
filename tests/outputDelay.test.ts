import assert from 'node:assert/strict';
import { test } from './testHarness';
import type { ConfigPort } from '../src/ports/ConfigPort';
import {
  OUTPUT_DELAY_MAX_MS,
  parseOutputDelayMs,
  setOutputDelayMs,
} from '../src/adapters/http/outputDelay';

/*
 * The output delay is written by two transports — the admin UI and the public API — and the fiddly
 * part is not the value, it is *where* it has to be written. A zone's output config appears under
 * several keys for historical reasons (`output`, `transports[0]`, and the legacy primary), and a
 * value written to only some of them reads back different after a restart: the UI shows 60 ms, the
 * device gets 0, and nothing errors.
 *
 * That is why there is one setter rather than one per transport, and why these tests assert the
 * mirroring rather than the return value. They cover both callers by covering the thing both call.
 */

type Cfg = { zones?: Array<Record<string, unknown>> };

function fakeConfig(zone: Record<string, unknown>): { cfg: Cfg; port: ConfigPort; writes: number } {
  const cfg: Cfg = { zones: [zone] };
  const state = { writes: 0 };
  const port = {
    getConfig: () => cfg,
    updateConfig: async (mutate: (c: Cfg) => void) => {
      state.writes += 1;
      mutate(cfg);
    },
  } as unknown as ConfigPort;
  return {
    cfg,
    port,
    get writes() {
      return state.writes;
    },
  };
}

test('the delay reaches every mirror of a zone output config', async () => {
  // The shape a zone can really have: the same output under three keys.
  const zone = {
    id: 3,
    output: { id: 'sendspin', clientId: 'living', latencyMs: 0 },
    transports: [{ id: 'sendspin', clientId: 'living', latencyMs: 0 }],
  };
  const { cfg, port } = fakeConfig(zone);
  const applied: Array<{ zoneId: number; ms: number; clientId?: string }> = [];

  const result = await setOutputDelayMs(
    {
      configPort: port,
      setOutputLatency: (zoneId, ms, clientId) => {
        applied.push({ zoneId, ms, ...(clientId ? { clientId } : {}) });
        return true;
      },
    },
    3,
    60,
  );

  assert.deepEqual(result, { delayMs: 60, applied: true });
  const written = cfg.zones![0] as { output: { latencyMs: number }; transports: Array<{ latencyMs: number }> };
  assert.equal(written.output.latencyMs, 60, 'the output mirror');
  assert.equal(written.transports[0]!.latencyMs, 60, 'the transports mirror');
  assert.deepEqual(applied, [{ zoneId: 3, ms: 60 }], 'and it was pushed to the live output');
});

test('a satellite gets its own delay without disturbing the zone or its siblings', async () => {
  /*
   * A subwoofer sitting under a pair of speakers needs a different offset from them. Writing it
   * must not touch the zone's own delay — that would move the speakers to fix the sub.
   */
  const zone = {
    id: 3,
    output: {
      id: 'sendspin',
      clientId: 'living',
      latencyMs: 20,
      satellites: 'sub-living, ledfx-living',
    },
  };
  const { cfg, port } = fakeConfig(zone);
  const applied: Array<{ ms: number; clientId?: string }> = [];

  await setOutputDelayMs(
    {
      configPort: port,
      setOutputLatency: (_zoneId, ms, clientId) => {
        applied.push({ ms, ...(clientId ? { clientId } : {}) });
        return true;
      },
    },
    3,
    35,
    'sub-living',
  );

  const written = cfg.zones![0] as {
    output: { latencyMs: number; satellites: Array<{ clientId: string; latencyMs?: number }> };
  };
  assert.equal(written.output.latencyMs, 20, "the zone's own delay is untouched");
  const sats = written.output.satellites;
  assert.equal(sats.find((s) => s.clientId === 'sub-living')?.latencyMs, 35, 'the targeted satellite');
  assert.notEqual(
    sats.find((s) => s.clientId === 'ledfx-living')?.latencyMs,
    35,
    'and only that one',
  );
  assert.deepEqual(applied, [{ ms: 35, clientId: 'sub-living' }]);
});

test('a stored delay is reported as stored even when no live output took it', async () => {
  /*
   * `applied: false` is a success. The zone may be configured for a protocol with no delay, or the
   * device may simply not be connected yet — and the value has to be waiting for it when it is.
   */
  const { cfg, port } = fakeConfig({ id: 3, output: { id: 'dlna', latencyMs: 0 } });
  const result = await setOutputDelayMs({ configPort: port, setOutputLatency: () => false }, 3, 80);
  assert.deepEqual(result, { delayMs: 80, applied: false });
  assert.equal((cfg.zones![0] as { output: { latencyMs: number } }).output.latencyMs, 80);
});

test('an unknown zone writes nothing rather than inventing a config entry', async () => {
  const { cfg, port } = fakeConfig({ id: 3, output: { id: 'sendspin', latencyMs: 0 } });
  await setOutputDelayMs({ configPort: port, setOutputLatency: () => false }, 99, 40);
  assert.equal((cfg.zones![0] as { output: { latencyMs: number } }).output.latencyMs, 0);
  assert.equal(cfg.zones!.length, 1);
});

test('the value is clamped, and a non-number is refused rather than defaulted', () => {
  assert.equal(parseOutputDelayMs(60), 60);
  assert.equal(parseOutputDelayMs('60'), 60, 'a form field is a string');
  assert.equal(parseOutputDelayMs(60.4), 60, 'rounded — the wire carries whole ms');
  assert.equal(parseOutputDelayMs(-10), 0);
  assert.equal(parseOutputDelayMs(999_999), OUTPUT_DELAY_MAX_MS);
  // Not 0: silently reading nonsense as "no delay" would move a speaker nobody asked to move.
  assert.equal(parseOutputDelayMs('soon'), null);
  assert.equal(parseOutputDelayMs(null), null);
  assert.equal(parseOutputDelayMs(undefined), null);
  assert.equal(parseOutputDelayMs(Number.NaN), null);
});
