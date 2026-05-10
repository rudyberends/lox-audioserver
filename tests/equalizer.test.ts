import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  buildEqualizerFilterChain,
  EQUALIZER_BAND_FREQUENCIES,
  formatEqualizerSettings,
  normalizeEqualizerBands,
  parseEqualizerSettings,
  resolveEqForwardUrl,
} from '../src/domain/zones/equalizer';
import { createZoneHandlers } from '../src/adapters/loxone/commands/handlers/zoneHandlers';
import { serializeResult } from '../src/adapters/loxone/commands/responses';

test('equalizer helpers normalize 10 Loxone bands', () => {
  assert.deepEqual(
    normalizeEqualizerBands([9, 6, 3.5, 1, 0, -1, -3.5, -6, -9, '2.5']),
    [6, 6, 3.5, 1, 0, -1, -3.5, -6, -6, 2.5],
  );
  assert.deepEqual(
    parseEqualizerSettings('3.5,3,2,1,0,0,-1,-2.5,-2,-3'),
    [3.5, 3, 2, 1, 0, 0, -1, -2.5, -2, -3],
  );
  assert.equal(
    formatEqualizerSettings([3.5, 3, 2, 1, 0, 0, -1, -2.5, -2, -3]),
    '3.5,3,2,1,0,0,-1,-2.5,-2,-3',
  );
  assert.equal(parseEqualizerSettings('1,2,3'), null);
});

test('built-in equalizer filter chain emits one ffmpeg equalizer= entry per non-zero band', () => {
  assert.equal(buildEqualizerFilterChain(null), null);
  assert.equal(buildEqualizerFilterChain([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), null);
  const chain = buildEqualizerFilterChain([3, 0, 0, 0, 0, 0, 0, 0, 0, -2.5]);
  assert.equal(
    chain,
    `equalizer=f=${EQUALIZER_BAND_FREQUENCIES[0]}:t=q:w=1:g=3,equalizer=f=${EQUALIZER_BAND_FREQUENCIES[9]}:t=q:w=1:g=-2.5`,
  );
  // Sub-audible bands (|g| < 0.05) are skipped to keep the chain tight.
  assert.equal(buildEqualizerFilterChain([0.04, 0, 0, 0, 0, 0, 0, 0, 0, 0]), null);
});

test('eq forward URL resolves only when provider is squeezelite-mr with a valid http URL', () => {
  assert.equal(
    resolveEqForwardUrl({
      id: 24,
      name: 'Kitchen',
      sourceMac: '00:00:00:00:00:01',
      equalizer: {
        provider: 'squeezelite-mr',
        callbackUrl: 'http://loxberry/plugins/squeezelite_mr/api.php?op=loxone_eq_set',
      },
      volumes: baseVolumes(),
    }),
    'http://loxberry/plugins/squeezelite_mr/api.php?op=loxone_eq_set',
  );
  assert.equal(
    resolveEqForwardUrl({
      id: 24,
      name: 'Kitchen',
      sourceMac: '00:00:00:00:00:01',
      equalizer: { provider: 'squeezelite-mr', callbackUrl: 'file:///tmp/eq' },
      volumes: baseVolumes(),
    }),
    null,
  );
  assert.equal(
    resolveEqForwardUrl({
      id: 24,
      name: 'Kitchen',
      sourceMac: '00:00:00:00:00:01',
      equalizer: { provider: 'off', callbackUrl: 'http://loxberry/x' },
      volumes: baseVolumes(),
    }),
    null,
  );
  assert.equal(
    resolveEqForwardUrl({
      id: 24,
      name: 'Kitchen',
      sourceMac: '00:00:00:00:00:01',
      equalizer: { provider: 'squeezelite-mr' },
      volumes: baseVolumes(),
    }),
    null,
  );
});

test('audio equalizersettings updates state and forwards squeezelite callback', async () => {
  const previousFetch = globalThis.fetch;
  const forwarded: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    forwarded.push({ url: String(url), init: init ?? {} });
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;

  const updates: unknown[] = [];
  const handlers = createZoneHandlers(
    {
      setEqualizerBands: async (_zoneId: number, bands: unknown) => {
        updates.push(bands);
        return {
          zoneId: 24,
          bands: bands as any,
          equalizerSettings: formatEqualizerSettings(bands as number[]),
        };
      },
    } as any,
    {} as any,
    {} as any,
    {} as any,
    {
      getConfig: () => ({
        zones: [
          {
            id: 24,
            name: 'Kitchen',
            sourceMac: '00:00:00:00:00:01',
            output: { id: 'squeezelite' },
            equalizer: {
              provider: 'squeezelite-mr',
              callbackUrl: 'http://loxberry/plugins/squeezelite_mr/api.php?op=loxone_eq_set',
            },
            volumes: baseVolumes(),
          },
        ],
      }),
    } as any,
  );

  try {
    await handlers.audioEqualizerSettings('audio/24/equalizersettings/3,3,2,1,0,0,-1,-2,-2,-3');
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.deepEqual(updates, [[3, 3, 2, 1, 0, 0, -1, -2, -2, -3]]);
  assert.equal(forwarded.length, 1);
  assert.equal(
    forwarded[0]?.url,
    'http://loxberry/plugins/squeezelite_mr/api.php?op=loxone_eq_set',
  );
  assert.equal(forwarded[0]?.init.method, 'POST');
  assert.equal(
    forwarded[0]?.init.body,
    JSON.stringify({ zoneId: 24, bands: [3, 3, 2, 1, 0, 0, -1, -2, -2, -3] }),
  );
});

test('audio cfg geteq returns MSG-compatible band descriptors', () => {
  const handlers = createZoneHandlers(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {
      getConfig: () => ({
        zones: [
          {
            id: 14,
            name: 'Kitchen',
            sourceMac: '00:00:00:00:00:01',
            equalizer: { bands: [3, 3, 2, 1, 0, 0, -1, -2, -2, -3] },
            volumes: baseVolumes(),
          },
        ],
      }),
    } as any,
  );

  const result = handlers.audioCfgGetEq('audio/cfg/geteq/14');

  assert.deepEqual(result.payload, [
    { id: 0, high: 10, low: -10, step: 0.5, value: 3, name: '31 Hz' },
    { id: 1, high: 10, low: -10, step: 0.5, value: 3, name: '63 Hz' },
    { id: 2, high: 10, low: -10, step: 0.5, value: 2, name: '125 Hz' },
    { id: 3, high: 10, low: -10, step: 0.5, value: 1, name: '250 Hz' },
    { id: 4, high: 10, low: -10, step: 0.5, value: 0, name: '500 Hz' },
    { id: 5, high: 10, low: -10, step: 0.5, value: 0, name: '1 kHz' },
    { id: 6, high: 10, low: -10, step: 0.5, value: -1, name: '2 kHz' },
    { id: 7, high: 10, low: -10, step: 0.5, value: -2, name: '4 kHz' },
    { id: 8, high: 10, low: -10, step: 0.5, value: -2, name: '8 kHz' },
    { id: 9, high: 10, low: -10, step: 0.5, value: -3, name: '16 kHz' },
  ]);
  assert.match(serializeResult(result), /"geteq_result"/);
});

test('audio cfg seteq updates one band through the equalizer pipeline', async () => {
  let updatedBands: unknown = null;
  const previousFetch = globalThis.fetch;
  const forwarded: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    forwarded.push({ url: String(url), init: init ?? {} });
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;
  const handlers = createZoneHandlers(
    {
      setEqualizerBands: async (_zoneId: number, bands: unknown) => {
        updatedBands = bands;
        return {
          zoneId: 14,
          bands: bands as any,
          equalizerSettings: formatEqualizerSettings(bands as number[]),
        };
      },
    } as any,
    {} as any,
    {} as any,
    {} as any,
    {
      getConfig: () => ({
        zones: [
          {
            id: 14,
            name: 'Kitchen',
            sourceMac: '00:00:00:00:00:01',
            equalizer: {
              bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
              provider: 'squeezelite-mr',
              callbackUrl: 'http://loxberry/plugins/squeezelite_mr/api.php?op=loxone_eq_set',
            },
            output: { id: 'squeezelite' },
            volumes: baseVolumes(),
          },
        ],
      }),
    } as any,
  );

  let result;
  try {
    result = await handlers.audioCfgSetEq('audio/cfg/seteq/14/2/3.5');
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.deepEqual(updatedBands, [0, 0, 3.5, 0, 0, 0, 0, 0, 0, 0]);
  assert.match(serializeResult(result), /"seteq_result"/);
  assert.equal(forwarded.length, 1);
  assert.equal(
    forwarded[0]?.init.body,
    JSON.stringify({ zoneId: 14, bands: [0, 0, 3.5, 0, 0, 0, 0, 0, 0, 0] }),
  );
});

test('audio cfg seteq accepts Loxone App bulk float payload', async () => {
  let updatedBands: unknown = null;
  const handlers = createZoneHandlers(
    {
      setEqualizerBands: async (_zoneId: number, bands: unknown) => {
        updatedBands = bands;
        return {
          zoneId: 21,
          bands: bands as any,
          equalizerSettings: formatEqualizerSettings(bands as number[]),
        };
      },
    } as any,
    {} as any,
    {} as any,
    {} as any,
    {
      getConfig: () => ({
        zones: [
          {
            id: 21,
            name: 'Kitchen',
            sourceMac: '00:00:00:00:00:01',
            equalizer: { bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
            volumes: baseVolumes(),
          },
        ],
      }),
    } as any,
  );

  const result = await handlers.audioCfgSetEq('audio/cfg/seteq/21/3.5,3,3,6,4,0,-1,-1,0,0');

  assert.deepEqual(updatedBands, [3.5, 3, 3, 6, 4, 0, -1, -1, 0, 0]);
  assert.match(serializeResult(result), /"seteq_result"/);
});

function baseVolumes() {
  return {
    default: 35,
    alarm: 55,
    fire: 55,
    bell: 45,
    buzzer: 45,
    tts: 45,
    volstep: 3,
    fading: 0,
    maxVolume: 100,
  };
}
