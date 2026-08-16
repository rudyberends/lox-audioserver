import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import { buildConfigRoutes, defaultConfig } from '../src/adapters/http/adminApi/config/configHandlers';
import type { AudioServerConfig } from '../src/domain/config/types';

/** Drives POST /config/system with a body, returning the status/payload it answered
 *  with plus the config that survived the update. */
async function postSystem(
  body: unknown,
  seed: AudioServerConfig = defaultConfig(),
): Promise<{ status: number; payload: unknown; cfg: AudioServerConfig }> {
  const cfg = seed;
  let status = 0;
  let payload: unknown = null;
  const routes = buildConfigRoutes({
    readJsonBody: async () => body,
    sendJson: (_res: ServerResponse, code: number, value: unknown) => {
      status = code;
      payload = value;
    },
    configPort: {
      updateConfig: async (mutate: (draft: AudioServerConfig) => void) => {
        mutate(cfg);
      },
    },
  } as never);
  const route = routes.find((entry) => entry.method === 'POST' && entry.pattern.test('/config/system'));
  assert.ok(route, 'POST /config/system route missing');
  await route!.handler(
    {} as IncomingMessage,
    { writableEnded: false } as ServerResponse,
    [] as unknown as RegExpMatchArray,
    '/config/system',
  );
  return { status, payload, cfg };
}

test('system update persists crossfadeSec on its own', async () => {
  // The admin UI posts nothing but this field, so it has to satisfy the
  // "at least one known field" guard by itself (issue #346).
  const accepted = await postSystem({ audioserver: { crossfadeSec: 6 } });
  assert.equal(accepted.status, 204);
  assert.equal(accepted.cfg.system.audioserver.crossfadeSec, 6);

  const disabled = await postSystem({ audioserver: { crossfadeSec: 0 } }, accepted.cfg);
  assert.equal(disabled.status, 204);
  assert.equal(disabled.cfg.system.audioserver.crossfadeSec, 0);
});

test('system update rejects an out-of-range crossfadeSec', async () => {
  for (const value of [-1, 21, Number.NaN]) {
    const result = await postSystem({ audioserver: { crossfadeSec: value } });
    assert.equal(result.status, 400, `crossfadeSec ${value} should be refused`);
    assert.deepEqual(result.payload, { error: 'invalid-crossfade-sec' });
    assert.equal(result.cfg.system.audioserver.crossfadeSec, undefined);
  }
});

test('system update still refuses a body with no known field', async () => {
  const result = await postSystem({ audioserver: { nonsense: true } });
  assert.equal(result.status, 400);
  assert.deepEqual(result.payload, { error: 'invalid-system-payload' });
});
