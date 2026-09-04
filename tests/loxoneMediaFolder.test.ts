import assert from 'node:assert/strict';
import { test } from './testHarness';
import { createProviderHandlers } from '../src/adapters/loxone/commands/handlers/providerHandlers';
import { serializeResult } from '../src/adapters/loxone/commands/responses';
import type { ContentManager } from '../src/adapters/content/contentManager';
import type { ContentFolder } from '../src/ports/ContentTypes';
import type { LoxoneWsNotifier } from '../src/adapters/loxone/ws/notifier';

const TOTAL = 470;

/**
 * A folder of {@link TOTAL} rows that answers exactly the page it is asked for, and
 * remembers what it was asked — the page the handler requests is the thing under test.
 */
function fakeLibrary() {
  const ask = { offset: -1, limit: -1 };
  const contentManager = {
    getMediaFolder: async (folderId: string, offset: number, limit: number): Promise<ContentFolder> => {
      ask.offset = offset;
      ask.limit = limit;
      const rows = Math.max(0, Math.min(limit, TOTAL - offset));
      return {
        id: folderId,
        name: 'Albums',
        start: offset,
        totalitems: TOTAL,
        items: Array.from({ length: rows }, (_, index) => ({
          id: `album-${offset + index}`,
          name: `Album ${offset + index}`,
          type: 1,
        })),
      };
    },
  } as unknown as ContentManager;
  const handlers = createProviderHandlers(contentManager, {} as unknown as LoxoneWsNotifier);
  const browse = async (command: string) =>
    JSON.parse(serializeResult(await handlers.audioCfgGetMediaFolder(command))).getmediafolder_result[0];
  return { ask, browse };
}

// The app renders every answer as a chunk of its own and drains a backlog of chunks
// newest-first, which lets the chunk holding the end of the list latch `isFinished`
// while earlier ones are still queued — and those are then dropped. Fifty rows at a
// time out of a library of thousands guarantees that backlog, so the whole folder
// goes out in one answer instead (#347).
test('a media folder goes out in one answer, not in fifty-row slivers', async () => {
  const { ask, browse } = fakeLibrary();

  const folder = await browse('audio/cfg/getmediafolder/library-local-albums/0/50');

  assert.ok(ask.limit >= TOTAL, `asked for ${ask.limit} rows, which cannot cover ${TOTAL}`);
  assert.equal(folder.items.length, TOTAL);
  // The app matches an answer to its request by start, and calls the load finished
  // once it holds `totalitems` rows. Both have to keep describing the same list.
  assert.equal(folder.start, 0);
  assert.equal(folder.totalitems, TOTAL);
});

test('a client that asks for more than that keeps its own count', async () => {
  const { ask, browse } = fakeLibrary();

  await browse('audio/cfg/getmediafolder/library-local-tracks/0/20000');

  assert.equal(ask.limit, 20000);
});

// A page deep into a long folder still has to come back keyed to the start it was
// asked for, or the app discards it as an answer to a question it did not ask.
test('a later page answers from the offset it was asked for', async () => {
  const { ask, browse } = fakeLibrary();

  const folder = await browse('audio/cfg/getmediafolder/library-local-albums/450/50');

  assert.equal(ask.offset, 450);
  assert.equal(folder.start, 450);
  assert.equal(folder.items.length, TOTAL - 450);
  assert.equal(folder.totalitems, TOTAL);
});
