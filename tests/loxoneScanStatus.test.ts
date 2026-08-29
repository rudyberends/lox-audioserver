import assert from 'node:assert/strict';
import { test } from './testHarness';
import { createProviderHandlers } from '../src/adapters/loxone/commands/handlers/providerHandlers';
import { serializeResult } from '../src/adapters/loxone/commands/responses';
import type { ContentManager } from '../src/adapters/content/contentManager';
import type { LoxoneWsNotifier } from '../src/adapters/loxone/ws/notifier';
import type { ScanStatus } from '../src/ports/ContentTypes';

const handlersFor = (status: ScanStatus) =>
  createProviderHandlers(
    { getScanStatus: () => status } as unknown as ContentManager,
    {} as unknown as LoxoneWsNotifier,
  );

// The app decides whether the library is being indexed with `0 !== data[0].scanning`,
// so the state has to ride in that field. A bare number reads as `undefined` there,
// which counts as "scanning" forever — and a library browser that believes it is
// re-indexing discards every content chunk it is handed, so the list stops at
// whatever had already arrived (#347).
test('scanstatus names the state in the field the app reads', async () => {
  for (const status of [0, 1, 2] as ScanStatus[]) {
    const result = await handlersFor(status).audioCfgScanStatus('audio/cfg/scanstatus');
    const payload = JSON.parse(serializeResult(result)).scanstatus_result;
    assert.deepEqual(payload, [{ scanning: status }], `status ${status}`);
  }
});
