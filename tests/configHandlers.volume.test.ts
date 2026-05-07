import assert from 'node:assert/strict';
import { test } from './testHarness';
import { createConfigHandlers } from '../src/adapters/loxone/commands/handlers/configHandlers';
import { serializeResult } from '../src/adapters/loxone/commands/responses';

test('volume config commands return Loxone-compatible result names', async () => {
  const calls: string[] = [];
  const handlers = createConfigHandlers({} as any, {
    notifier: {} as any,
    configPort: {} as any,
    contentManager: {} as any,
    spotifyInputService: {} as any,
    configService: {
      applyDefaultVolume: async (zoneId: number, value: number) => {
        calls.push(`default:${zoneId}:${value}`);
      },
      applyMaxVolume: async (zoneId: number, value: number) => {
        calls.push(`max:${zoneId}:${value}`);
      },
      applyEventVolumes: async (zoneId: number, volumes: Record<string, number>) => {
        calls.push(`event:${zoneId}:${volumes.tts}`);
      },
    } as any,
  });

  const encoded = Buffer.from(JSON.stringify({ playerid: 7, tts: 44 })).toString('base64');
  const defaultResult = await handlers.setDefaultVolume('audio/cfg/defaultvolume/7/31');
  const maxResult = await handlers.setMaxVolume('audio/cfg/maxvolume/7/88');
  const eventResult = await handlers.setEventVolumes(`audio/cfg/eventvolumes/${encoded}`);

  assert.ok(defaultResult);
  assert.ok(maxResult);
  assert.ok(eventResult);
  assert.match(serializeResult(defaultResult), /"defaultvolume_result"/);
  assert.match(serializeResult(maxResult), /"maxvolume_result"/);
  assert.match(serializeResult(eventResult), /"eventvolumes_result"/);
  assert.deepEqual(calls, ['default:7:31', 'max:7:88', 'event:7:44']);
});
