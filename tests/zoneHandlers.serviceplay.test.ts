import assert from 'node:assert/strict';
import { test } from './testHarness';
import { createZoneHandlers } from '../src/adapters/loxone/commands/handlers/zoneHandlers';

test('audio serviceplay strips parentid suffix for metadata lookup', async () => {
  let metadataTarget = '';
  let playedUri = '';
  const zoneHandlers = createZoneHandlers(
    {
      getState: () => undefined,
      getQueue: () => ({ id: 7, items: [], shuffle: false, start: 0, totalitems: 0 }),
      handleCommand: () => {},
      setPendingShuffle: () => {},
      seekInQueue: () => false,
      playContent: async (_zoneId: number, uri: string) => {
        playedUri = uri;
      },
      getMetadata: () => ({}),
    } as any,
    { get: async () => ({}) } as any,
    { get: async () => ({ items: [] }) } as any,
    {
      resolveMetadata: async (uri: string) => {
        metadataTarget = uri;
        return null;
      },
    } as any,
  );

  const command =
    'audio/7/serviceplay/spotify/Manu/spotify@Manu:track:6KhSk0XaifZje1L3n2zUUq/parentid/4/25/noshuffle/?q&ZW5mb3JjZVVzZXI9dHJ1ZQ';
  await zoneHandlers.audioServicePlay(command);

  assert.equal(metadataTarget, 'spotify@Manu:track:6KhSk0XaifZje1L3n2zUUq');
  assert.equal(
    playedUri,
    'spotify@Manu:track:6KhSk0XaifZje1L3n2zUUq/parentpath/spotify@Manu:user:collection/25',
  );
});
