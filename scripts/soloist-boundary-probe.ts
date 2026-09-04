/**
 * What a track boundary costs on the single-track Soloist backend.
 *
 * The one number the shape rests on. Every track is its own engine run, so a boundary pays a
 * process start and a session restore on top of the track load that was always there — and the gap
 * that matters is the one between the last byte of one track and the first byte of the next, since
 * that is what the room's own buffer has to bridge.
 *
 * Two boundaries, because they cost differently:
 *   `natural`  the engine runs out of track and exits by itself, which is every ordinary boundary
 *   `skip`     the run is stopped mid-track, which also has to wait for its store's lock
 *
 * Needs an account whose Soloist store is signed in. Measured against the sound card directly, so
 * nothing has to be playing in a room and nothing is heard.
 *
 *   SOLOIST_KEY=spak_… npx tsx scripts/soloist-boundary-probe.ts [natural|skip]
 */
import { PulseSoundCard } from '@/adapters/inputs/pulse/pulseSoundCard';
import { SoloistTrackRun, type TrackRunEnd } from '@/adapters/inputs/spotify/soloist/soloistTrackRun';

const ZONE_ID = 994;
const ACCOUNT = process.env.ACCOUNT ?? 'md123121';
const FIRST = process.env.URI ?? 'spotify:track:4cOdK2wGLETKBW3PvgPWqT';
const SECOND = process.env.URI2 ?? 'spotify:track:7ouMYWpwJ422jRcDASZB7P';
/** Far enough into the first track that it runs out while the probe is watching. */
const NEAR_THE_END_MS = Number(process.env.SEEK ?? 205_000);

type Watched = {
  run: SoloistTrackRun;
  /** When the card last had audio for this track, which is where a boundary starts. */
  lastByteAt: () => number;
  firstByteAt: () => number;
};

async function play(
  card: PulseSoundCard,
  uri: string,
  seekPositionMs: number,
  onEnd: (end: TrackRunEnd) => void,
): Promise<Watched | null> {
  card.forgetSpec(ZONE_ID);
  const started = await SoloistTrackRun.start({
    zoneId: ZONE_ID,
    uri,
    accountId: ACCOUNT,
    apiKey: process.env.SOLOIST_KEY as string,
    deviceName: 'Boundary probe',
    lossless: true,
    normalize: true,
    seekPositionMs,
    env: await card.childEnv(ZONE_ID),
    onEnd,
  });
  if (!started.ok) {
    console.log(`${uri} refused: ${started.failure}`);
    return null;
  }
  await card.waitForSpec(ZONE_ID);
  const stream = card.takeStream(ZONE_ID);
  let first = 0;
  let last = 0;
  stream?.on('data', () => {
    first ||= Date.now();
    last = Date.now();
  });
  return { run: started.run, lastByteAt: () => last, firstByteAt: () => first };
}

async function main(): Promise<void> {
  const mode = process.argv[2] === 'skip' ? 'skip' : 'natural';
  const card = new PulseSoundCard('probe');
  await card.ensure(ZONE_ID);

  let endedAt = 0;
  const first = await play(card, FIRST, mode === 'natural' ? NEAR_THE_END_MS : 0, (end) => {
    endedAt ||= Date.now();
    console.log(`first track ended: ${JSON.stringify(end)}`);
  });
  if (!first) {
    process.exit(1);
  }

  if (mode === 'natural') {
    const deadline = Date.now() + 60_000;
    while (!endedAt && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!endedAt) {
      console.log('the track never ran out; seek further in with SEEK=');
      await first.run.stop();
      process.exit(1);
    }
  } else {
    await new Promise((r) => setTimeout(r, 4000));
    // Stopping waits for the store's lock, which a skip has to and a natural end does not.
    await first.run.stop();
  }
  const lastByteOfFirst = first.lastByteAt();

  const askedAt = Date.now();
  const second = await play(card, SECOND, 0, () => undefined);
  if (!second) {
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 4000));
  console.log(
    `${mode}: first byte of the next track ${second.firstByteAt() - askedAt} ms after asking, ` +
      `silence at the boundary ${second.firstByteAt() - lastByteOfFirst} ms`,
  );
  await second.run.stop();
  await card.stop();
  process.exit(0);
}

void main();
