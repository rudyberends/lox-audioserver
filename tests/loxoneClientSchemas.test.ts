import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { test } from './testHarness';
import { ZoneRepository } from '../src/application/zones/ZoneRepository';
import { QueueController } from '../src/application/zones/QueueController';
import { PlaybackQueueNavigator } from '../src/application/playback/PlaybackQueueNavigator';
import { createRecentsManager } from '../src/application/zones/recents/recentsManager';
import { createFavoritesManager } from '../src/application/zones/favorites/favoritesManager';
import { buildBridgeRegistry } from '../src/domain/zones/bridgeIdentity';
import type { StreamingServiceConfig } from '../src/domain/config/types';
import type { QueueState, ZoneContext } from '../src/application/zones/internal/zoneTypes';
import type { NotifierPort } from '../src/ports/NotifierPort';
import type { ContentPort } from '../src/ports/ContentPort';

/**
 * The native client's own schemas, transcribed.
 *
 * Read out of the shipped client — `data/refcode/client/Loxone.app/app-arm64.asar`,
 * `www/scripts/legacy/comps.js` — and written here in the same zod the client uses, so our
 * payloads can be parsed by the real contract instead of by our idea of it. Module ids and
 * export names are quoted per schema so each one can be found again in that file.
 *
 * Why this matters more than it looks: these three views have no tolerance to spare. The queue
 * is a `z.array(z.union([...]))` with no `.catch()` — one item no member accepts throws the
 * whole array and the queue comes up empty. Recents and favourites catch per item and then
 * `.filter(Boolean)`, so a wrong item does not throw; it silently disappears, which reads as an
 * empty view and is harder to notice than a crash.
 *
 * Transcribed faithfully, including the parts that look redundant. Where the client is tolerant
 * (`.catch()`, `.optional()`) that tolerance is copied too — the point is to fail here exactly
 * when the client would fail, and not before.
 */

// --- shared helpers (comps.js module 332737) --------------------------------

/** `z.string().transform(v => v.length > 0 ? v : undefined).optional()` */
const StringOrUndefinedIfEmpty = z
  .string()
  .transform((v) => (v.length > 0 ? v : undefined))
  .optional();

// --- queue (module 929207 RawQueueInputScheme, 659628 PreProcessing) --------

/** `QueueAudioType`, module 411996. */
const QueueAudioType = { Unknown: -1, File: 0, Stream: 1, Playlist: 2, LineIn: 3, AirPlay: 4, Spotify: 5 };

const RawQueueInputScheme = z.object({
  album: StringOrUndefinedIfEmpty,
  artist: StringOrUndefinedIfEmpty,
  station: z.string().optional(),
  title: StringOrUndefinedIfEmpty.default(''),
  user: StringOrUndefinedIfEmpty,
  duration: z.number(),
  unique_id: z.string(),
  audiopath: z.string(),
  audiotype: z.number(),
  coverurl: z.string().optional(),
  qindex: z.number(),
  icontype: z.number().optional(),
});

/**
 * The five members of the queue union, each pinned to one `audiotype` literal.
 *
 * `Playlist` (2) is absent, and that absence is the sharp edge: an item carrying it matches no
 * member, so the union throws and the array throws with it.
 */
const QueueItemUnion = z.union([
  RawQueueInputScheme.extend({ audiotype: z.literal(QueueAudioType.Stream) }),
  RawQueueInputScheme.extend({ audiotype: z.literal(QueueAudioType.LineIn) }),
  RawQueueInputScheme.extend({ audiotype: z.literal(QueueAudioType.File) }),
  RawQueueInputScheme.extend({ audiotype: z.literal(QueueAudioType.Spotify) }),
  RawQueueInputScheme.extend({ audiotype: z.literal(QueueAudioType.AirPlay) }),
]);

const GetQueueResult = z.object({
  id: z.coerce.number(),
  items: z.array(QueueItemUnion),
  shuffle: z.coerce.boolean(),
  start: z.number(),
  totalitems: z.number(),
});

/**
 * What the client does with a queued Spotify item's audiopath (module 353080): it splits on `:`
 * and switches on the second segment, and only `track` and `episode` become a real item type.
 */
function queuedSpotifyTag(audiopath: string): string | null {
  if (!audiopath.startsWith('spotify:')) {
    return null;
  }
  const tag = audiopath.split(':')[1] ?? '';
  return tag === 'track' || tag === 'episode' ? tag : null;
}

// --- recents (modules 493493, 415981, 258462, 374838) ----------------------

/** `RecentlyPlayedType`, module 725264. */
const RECENTLY_PLAYED_TYPES = [
  'unknown',
  'linein',
  'spotify',
  'soundsuit',
  'library',
  'tunein',
  'custom_stream',
] as const;

/** `RecentlyPlayedBasedItemSchema`, module 493493. Note `coverurl` is required, not optional. */
const RecentlyPlayedBasedItemSchema = z
  .object({
    audiopath: z.string(),
    coverurl: z.string(),
    title: z.string(),
    service: z.enum(RECENTLY_PLAYED_TYPES).catch('unknown'),
    type: z.number().catch(-1),
    user: z.string().optional(),
  })
  .passthrough();

/** The audiopath fragments a recents Spotify item must contain (module 415981). */
const SPOTIFY_RECENT_TAGS = [':track', ':user:collection', ':playlist', ':album', ':artist', ':show', 'episode'];

const PreProcessingSpotifyItemScheme = RecentlyPlayedBasedItemSchema.extend({
  service: z.literal('spotify'),
  owner: z.string().optional(),
  owner_id: z.string().optional(),
}).refine(({ audiopath }) => SPOTIFY_RECENT_TAGS.some((tag) => audiopath.includes(tag)), {
  message: "Items 'audiopath' can only have the following strings included",
});

const PreProcessingLibraryItemScheme = RecentlyPlayedBasedItemSchema.extend({
  service: z.literal('library'),
});
const PreProcessingLineInItemScheme = RecentlyPlayedBasedItemSchema.extend({
  service: z.literal('linein'),
});
const PreProcessingRadioItemScheme = RecentlyPlayedBasedItemSchema.extend({
  service: z.enum(['tunein', 'custom_stream']),
});
const PreProcessingSoundsuitItemScheme = RecentlyPlayedBasedItemSchema.extend({
  service: z.literal('soundsuit'),
});

const RecentItemUnion = z.union([
  PreProcessingLineInItemScheme,
  PreProcessingLibraryItemScheme,
  PreProcessingSoundsuitItemScheme,
  PreProcessingSpotifyItemScheme,
  PreProcessingRadioItemScheme,
]);

/** `recent_result` (module 258462): items are caught per item, then filtered out. `ts` required. */
const RecentResult = z.object({
  items: z.array(z.unknown()),
  ts: z.number(),
});

/**
 * The serviceId the client derives from a recents item (module 415981): it replaces the
 * pattern `spotify@(.*?):.*` in the audiopath with the first capture group.
 *
 * A path that does not match returns unchanged — so the serviceId silently becomes the whole
 * audiopath, and that is what comes back on the play command.
 */
function clientServiceId(audiopath: string): string {
  return audiopath.replace(/spotify@(.*?):.*/, '$1');
}

// --- favourites (modules 231957, 204281, 264204) ---------------------------

/** `FavItemBaseScheme`, module 231957. `plus` and `slot` are required. */
const FavItemBaseScheme = z.object({
  id: z.coerce.number(),
  name: z.string().default(''),
  plus: z.boolean(),
  slot: z.number(),
  coverurl: z.string().optional(),
  audiopath: z.string().optional(),
});

/**
 * Every `type` the favourite union accepts (modules 204281, 255630, 459439, 70828, 169736, 46256).
 *
 * Grouped by which member claims it, because membership alone is not safety: `tunein`,
 * `custom_stream` and `loxoneradio` all belong to the RADIO member, so a streaming favourite
 * carrying one of them parses fine and then renders as a radio station. That is what every
 * Apple Music favourite did before `detectTypeFromAudiopath` learned the service-native shape.
 */
const FAV_TYPES_STREAMING = [
  'spotify_album',
  'spotify_artist',
  'spotify_collection',
  'spotify_episode',
  'spotify_playlist',
  'spotify_show',
  'spotify_track',
] as const;
const FAV_TYPES_RADIO = ['tunein', 'custom_stream', 'loxoneradio'] as const;
const FAV_TYPES = [
  ...FAV_TYPES_STREAMING,
  ...FAV_TYPES_RADIO,
  'library_folder',
  'library_track',
  'linein',
  'playlist',
  'normal',
  'soundsuit',
] as const;

const FavItem = FavItemBaseScheme.extend({ type: z.enum(FAV_TYPES) }).passthrough();

// --- harnesses -------------------------------------------------------------

const BRIDGES: StreamingServiceConfig[] = [
  { id: 'bridge-applemusic-12lijl', label: 'Apple Music', provider: 'applemusic' },
];

const contentPortFake = {
  getBridgeRegistry: () => buildBridgeRegistry(BRIDGES),
  getDefaultSpotifyAccountId: () => 'md123121',
  resolveMetadata: async () => null,
} as unknown as ContentPort;

const notifierFake = {
  notifyRecentlyPlayedChanged: () => {},
  notifyRoomFavoritesChanged: () => {},
  notifyQueueUpdated: () => {},
  notifyZoneStateChanged: () => {},
} as unknown as NotifierPort;

async function withTempCwd(fn: () => Promise<void>): Promise<void> {
  const originalCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lox-client-schema-'));
  process.chdir(tempDir);
  try {
    await fn();
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

type QueueSeed = {
  audiopath: string;
  audiotype: number;
  title?: string;
  station?: string;
  duration?: number;
};

/** The queue exactly as `audio/<zone>/getqueue` would answer it. */
function emitQueue(seeds: QueueSeed[]) {
  const zones = new ZoneRepository();
  const qc = new QueueController(zones, {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, spam: () => {} } as never,
    contentPort: contentPortFake as never,
    applyPatch: () => {},
    isRadioAudiopath: () => false,
    isSpotifyAudiopath: () => false,
    isMusicAssistantAudiopath: () => false,
    providerForAudiopath: () => null,
    resolveBridgeProvider: () => null,
    getMusicAssistantUserId: () => 'musicassistant',
    getStateAudiotype: () => null,
    getStateFileType: () => 0,
    resolveSourceName: () => undefined,
    notifier: notifierFake as never,
  } as never);
  const items = seeds.map((seed, idx) => ({
    album: '',
    artist: 'Artist',
    audiopath: seed.audiopath,
    audiotype: seed.audiotype,
    coverurl: '',
    duration: seed.duration ?? 180,
    qindex: idx,
    station: seed.station ?? '',
    title: seed.title ?? `Track ${idx}`,
    unique_id: `uid-${idx}`,
    user: 'nouser',
  }));
  const queue: QueueState = {
    items: items as never,
    shuffle: false,
    repeat: 0,
    currentIndex: 0,
    authority: 'local',
  };
  const navigator = new PlaybackQueueNavigator(queue);
  navigator.setItems(queue.items, 0);
  zones.set(1, {
    id: 1,
    name: 'Zone 1',
    queue,
    queueController: navigator,
    metadata: {} as Record<string, unknown>,
    state: { audiopath: '', audiotype: 0 },
  } as unknown as ZoneContext);
  return qc.getQueue(1, 0, 50);
}

// --- queue -----------------------------------------------------------------

test('client schema: a queue of bridged, real-Spotify and library items parses whole', () => {
  const emitted = emitQueue([
    { audiopath: 'applemusic:track:b64_MTc5MTg4MzY2Nw==', audiotype: 5 },
    { audiopath: 'applemusic:library-track:b64_YWJj', audiotype: 5 },
    { audiopath: 'spotify@md123121:track:2bJtJv5NGkYUFP6prU3WSg', audiotype: 5 },
    { audiopath: 'library:local:track:b64_YWJj', audiotype: 0 },
    { audiopath: 'https://stream.example/live.mp3', audiotype: 1, station: 'Some Radio' },
  ]);
  const parsed = GetQueueResult.safeParse(emitted);
  assert.ok(parsed.success, `queue rejected: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`);
});

test('client schema: every emitted streaming item reaches a real Spotify tag', () => {
  const emitted = emitQueue([
    { audiopath: 'applemusic:track:b64_MTc5MTg4MzY2Nw==', audiotype: 5 },
    // The Apple library alias has to come down to `track`: the client accepts no third tag.
    { audiopath: 'applemusic:library-track:b64_YWJj', audiotype: 5 },
    { audiopath: 'spotify@md123121:track:2bJtJv5NGkYUFP6prU3WSg', audiotype: 5 },
  ]);
  for (const item of emitted.items) {
    assert.equal(
      queuedSpotifyTag(item.audiopath),
      'track',
      `audiopath ${item.audiopath} would render as an Unknown item`,
    );
  }
});

test('client schema: audiotype Playlist(2) is the one value that empties the whole queue', () => {
  // Not a claim about our emit — a claim about the client, kept next to the emit that must
  // never produce it. `resolveDisplayAudiotype` maps Spotify(5)→Playlist(2), and that mapping
  // belongs to the zone *state*; the day it reaches a queue item, this is why the view dies.
  const emitted = emitQueue([
    { audiopath: 'spotify:track:abc', audiotype: 5 },
    { audiopath: 'spotify:track:def', audiotype: 2 },
  ]);
  const parsed = GetQueueResult.safeParse(emitted);
  assert.equal(parsed.success, false);
});

test('client schema: a queue item without a duration takes the whole queue with it', () => {
  // `duration: z.number()` — required, no default and no catch.
  const emitted = emitQueue([{ audiopath: 'spotify:track:abc', audiotype: 5 }]);
  const withoutDuration = {
    ...emitted,
    items: emitted.items.map((item) => {
      const { duration: _duration, ...rest } = item as Record<string, unknown>;
      return rest;
    }),
  };
  assert.equal(GetQueueResult.safeParse(withoutDuration).success, false);
  assert.equal(GetQueueResult.safeParse(emitted).success, true);
});

// --- recents ---------------------------------------------------------------

async function emitRecents(items: Array<Record<string, unknown>>) {
  await fs.mkdir(path.join(process.cwd(), 'data', 'recents'), { recursive: true });
  await fs.writeFile(
    path.join(process.cwd(), 'data', 'recents', '27.json'),
    JSON.stringify({ ts: 1, items }),
  );
  const recents = createRecentsManager({ notifier: notifierFake, contentPort: contentPortFake });
  return recents.get(27);
}

test('client schema: recents parse item by item, bridged and library alike', async () => {
  await withTempCwd(async () => {
    const emitted = await emitRecents([
      {
        audiopath: 'applemusic:track:b64_MTc5MTg4MzY2Nw==',
        coverurl: 'http://cover/1',
        title: 'Bridged Song',
        service: 'spotify',
        serviceType: 3,
        type: 2,
      },
      {
        audiopath: 'spotify@md123121:track:2bJtJv5NGkYUFP6prU3WSg',
        coverurl: 'http://cover/2',
        title: 'Real Spotify Song',
        service: 'spotify',
        serviceType: 3,
        type: 2,
      },
      {
        audiopath: 'library://local/Album/01.mp3',
        coverurl: '',
        title: 'Local Song',
        service: 'library',
        serviceType: 2,
        type: 2,
      },
    ]);
    assert.equal(RecentResult.safeParse(emitted).success, true);
    for (const item of emitted.items) {
      const parsed = RecentItemUnion.safeParse(item);
      assert.ok(
        parsed.success,
        `the client would drop ${item.audiopath}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`,
      );
    }
  });
});

test('client schema: a bridged recent yields an account as its serviceId, not its own path', async () => {
  await withTempCwd(async () => {
    const emitted = await emitRecents([
      {
        audiopath: 'applemusic:track:b64_MTc5MTg4MzY2Nw==',
        coverurl: 'http://cover/1',
        title: 'Bridged Song',
        service: 'spotify',
        serviceType: 3,
        type: 2,
      },
    ]);
    const audiopath = emitted.items[0]?.audiopath ?? '';
    // The envelope has to be on the way out, or the regex below returns the whole path.
    assert.equal(audiopath, 'spotify@bridge-applemusic-12lijl:track:b64_MTc5MTg4MzY2Nw==');
    const serviceId = clientServiceId(audiopath);
    assert.equal(serviceId, 'bridge-applemusic-12lijl');
    assert.ok(!serviceId.includes(':'), 'serviceId must be an account id, not an audiopath');
  });
});

test('client schema: a real Spotify recent keeps its own account as serviceId', async () => {
  await withTempCwd(async () => {
    const emitted = await emitRecents([
      {
        audiopath: 'spotify@md123121:track:2bJtJv5NGkYUFP6prU3WSg',
        coverurl: '',
        title: 'Real Spotify Song',
        service: 'spotify',
        serviceType: 3,
        type: 2,
      },
    ]);
    assert.equal(clientServiceId(emitted.items[0]?.audiopath ?? ''), 'md123121');
  });
});

test('client schema: a recent whose service is not one the client knows is dropped', () => {
  // Kept as a claim about the client: `service` falls back to `unknown`, which no member of the
  // union accepts, so the item vanishes from the list rather than failing loudly.
  const item = {
    audiopath: 'applemusic:track:b64_YWJj',
    coverurl: '',
    title: 'X',
    service: 'applemusic',
    type: 2,
  };
  assert.equal(RecentItemUnion.safeParse(item).success, false);
});

// --- favourites ------------------------------------------------------------

test('client schema: room favourites carry plus, slot and a known type', async () => {
  await withTempCwd(async () => {
    const favorites = createFavoritesManager({ notifier: notifierFake, contentPort: contentPortFake });
    favorites.initOnce({ zoneManager: { getState: () => undefined } as never });
    await favorites.add(27, 'Bridged Album', 'applemusic:album:b64_MTc5NjM2ODAzNg==');
    await favorites.add(27, 'Local Track', 'library://local/Album/01.mp3');

    const emitted = await favorites.get(27, 0, 50);
    assert.ok(Array.isArray(emitted.items) && emitted.items.length === 2);
    for (const item of emitted.items) {
      const parsed = FavItem.safeParse(item);
      assert.ok(
        parsed.success,
        `the client would drop favourite ${JSON.stringify(item.audiopath)}: ${
          parsed.success ? '' : JSON.stringify(parsed.error.issues)
        }`,
      );
    }
  });
});

test('client schema: a bridged favourite is a streaming type, not a radio one', async () => {
  await withTempCwd(async () => {
    const favorites = createFavoritesManager({ notifier: notifierFake, contentPort: contentPortFake });
    favorites.initOnce({ zoneManager: { getState: () => undefined } as never });
    await favorites.add(27, 'Bridged Album', 'applemusic:album:b64_MTc5NjM2ODAzNg==');
    await favorites.add(27, 'Bridged Track', 'applemusic:track:b64_MTg3NzExMTE5OA==');
    await favorites.add(27, 'Local Track', 'library://local/Album/01.mp3');

    const emitted = await favorites.get(27, 0, 50);
    const byName = new Map(emitted.items.map((item) => [item.name, item]));
    assert.equal(byName.get('Bridged Album')?.type, 'spotify_album');
    assert.equal(byName.get('Bridged Track')?.type, 'spotify_track');
    assert.equal(byName.get('Local Track')?.type, 'library_track');
    for (const name of ['Bridged Album', 'Bridged Track']) {
      const item = byName.get(name)!;
      assert.ok(
        !(FAV_TYPES_RADIO as readonly string[]).includes(String(item.type)),
        `${name} would be rendered as a radio station`,
      );
      assert.equal(item.service, 'spotify');
    }
  });
});

test('client schema: a stored custom_stream type is healed, not trusted', async () => {
  await withTempCwd(async () => {
    // Exactly what the stored favourites files hold today: a service-native path saved before
    // the shape was recognised, labelled with the radio type it fell through to.
    await fs.mkdir(path.join(process.cwd(), 'data', 'favorites'), { recursive: true });
    await fs.writeFile(
      path.join(process.cwd(), 'data', 'favorites', '27.json'),
      JSON.stringify({
        items: [
          {
            id: 1,
            slot: 1,
            name: 'Old Apple Favourite',
            title: 'Old Apple Favourite',
            audiopath: 'applemusic:track:b64_MTg3NzExMTE5OA==',
            type: 'custom_stream',
            service: 'custom',
            serviceType: 3,
            coverurl: '',
          },
        ],
      }),
    );
    const favorites = createFavoritesManager({ notifier: notifierFake, contentPort: contentPortFake });
    favorites.initOnce({ zoneManager: { getState: () => undefined } as never });

    const emitted = await favorites.get(27, 0, 50);
    assert.equal(emitted.items[0]?.type, 'spotify_track');
    assert.equal(emitted.items[0]?.service, 'spotify');
  });
});

test('client schema: a favourite without plus or slot is dropped by the client', async () => {
  await withTempCwd(async () => {
    const favorites = createFavoritesManager({ notifier: notifierFake, contentPort: contentPortFake });
    favorites.initOnce({ zoneManager: { getState: () => undefined } as never });
    await favorites.add(27, 'Bridged Album', 'applemusic:album:b64_MTc5NjM2ODAzNg==');
    const emitted = await favorites.get(27, 0, 50);

    for (const field of ['plus', 'slot'] as const) {
      const { [field]: _dropped, ...without } = emitted.items[0] as Record<string, unknown>;
      assert.equal(
        FavItem.safeParse(without).success,
        false,
        `${field} must stay on the payload`,
      );
    }
  });
});
