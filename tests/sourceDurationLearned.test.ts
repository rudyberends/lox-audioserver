import assert from 'node:assert/strict';
import { test } from './testHarness';
import { AudioManager, type PlaybackSource } from '../src/application/playback/audioManager';
import { ZoneAudioPreferences } from '../src/application/playback/ZoneAudioPreferences';
import { PlaybackService } from '../src/application/playback/PlaybackService';
import type { EnginePort, EngineSessionStats, EngineSessionTerminationHandler } from '../src/ports/EnginePort';
import type { EngineStartOptions } from '../src/ports/EngineTypes';
import type { SessionKey } from '../src/ports/types/SessionKey';
import { ZonePlayer } from '../src/application/playback/zonePlayer';

/*
 * #350: a track whose length nobody could state used to be given a hardcoded 120, and the zone clock
 * cut it off there. Nothing invents a length any more, which only works because the length is actually
 * learned: ffmpeg states it in the input banner and the engine reports it as `sourceDurationSec`.
 *
 * These cover that chain end to end at the manager: the two moments a length can arrive (while the
 * track plays, and at the exit of a source that only states it once fully read), and the fact that
 * arriving at the session is not enough — the zone clock is what ends a track, so it has to be told.
 */

class BannerEngine implements EnginePort {
  /** What ffmpeg has said so far. Null until the banner is read, exactly as `AudioSession` reports it. */
  public sourceDurationSec: number | null = null;
  public lastStartArgs: EngineStartOptions | null = null;
  public terminate: EngineSessionTerminationHandler | null = null;
  private alive = true;

  public start(...args: [EngineStartOptions] | [SessionKey, PlaybackSource, any?, any?]): void {
    if (args.length === 1) {
      this.lastStartArgs = args[0];
    }
  }

  public startWithHandoff(): void {}
  public stop(): void {}
  public createStream(): null {
    return null;
  }
  public createLocalSession(): any {
    return { start: () => {}, stop: () => {}, createSubscriber: () => null };
  }
  public waitForFirstChunk(): Promise<boolean> {
    return Promise.resolve(false);
  }
  public hasSession(): boolean {
    return this.alive;
  }
  public getSessionStats(): EngineSessionStats[] {
    return [{ subscribers: 1, sourceDurationSec: this.sourceDurationSec } as unknown as EngineSessionStats];
  }
  public setSessionTerminationHandler(handler: EngineSessionTerminationHandler): void {
    this.terminate = handler;
  }
  public restartZoneForEqualizer(): boolean {
    return false;
  }
  public async inlineCrossfade(): Promise<boolean> {
    return false;
  }

  /** ffmpeg exits after having read the whole source, stating its length only then. */
  public endOfSource(key: SessionKey, durationSec: number | null): void {
    this.alive = false;
    this.terminate?.(key, {
      lastExitCode: 0,
      lastExitSignal: null,
      lastStderr: null,
      sourceDurationSec: durationSec,
    } as unknown as EngineSessionStats);
  }
}

function buildManager() {
  const engine = new BannerEngine();
  const learned: Array<{ zoneId: number; durationSec: number }> = [];
  const manager = new AudioManager(
    new PlaybackService(engine),
    {
      notifyOutputError: () => {},
      notifyOutputState: () => {},
      notifySourceDuration: (zoneId, durationSec) => learned.push({ zoneId, durationSec }),
    },
    new ZoneAudioPreferences(),
  );
  return { manager, engine, learned };
}

/** The watcher polls twice a second; give it room without making the suite wait on real time. */
function afterAPoll(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 700));
}

test('a track that starts without a length gets the one ffmpeg reads, and the zone is told', async () => {
  const { manager, engine, learned } = buildManager();

  manager.startExternalPlayback(
    1,
    'applemusic',
    { kind: 'url', url: 'https://example.invalid/track.m4a' },
    { title: 'Perfume', artist: 'X', album: 'Y' },
    true,
  );
  assert.equal(manager.getSession(1)?.duration, 0, 'nothing is invented at start');
  assert.equal(learned.length, 0, 'and nothing is claimed before ffmpeg speaks');

  engine.sourceDurationSec = 240;
  await afterAPoll();

  assert.equal(manager.getSession(1)?.duration, 240, 'the session adopts the real length');
  assert.deepEqual(learned, [{ zoneId: 1, durationSec: 240 }], 'and the zone clock is told exactly once');
});

test('a length that only turns up when the source runs out is still adopted', async () => {
  const { manager, engine, learned } = buildManager();

  manager.startExternalPlayback(
    1,
    'applemusic',
    { kind: 'url', url: 'https://example.invalid/no-index-up-front.m4a' },
    { title: 'Perfume', artist: '', album: '' },
    true,
  );
  // A non-seekable source whose index sits at the end says nothing for the whole track...
  await afterAPoll();
  assert.equal(learned.length, 0);

  // ...and then states it as ffmpeg finishes reading. That is the only chance to learn it.
  engine.endOfSource(1 as unknown as SessionKey, 187);
  assert.deepEqual(learned, [{ zoneId: 1, durationSec: 187 }]);
});

test('a live source is left with no length all the way through the manager', async () => {
  const { manager, engine, learned } = buildManager();

  manager.startExternalPlayback(
    1,
    'tunein',
    { kind: 'url', url: 'https://example.invalid/stream' },
    { title: 'Station', artist: '', album: '', isRadio: true },
    true,
  );
  engine.sourceDurationSec = null;
  await afterAPoll();
  engine.endOfSource(1 as unknown as SessionKey, null);

  assert.equal(learned.length, 0, 'radio has no end, and pretending otherwise is what broke #350');
});

test('a length the provider already stated is passed to the engine so it keeps ffmpeg quiet', () => {
  const { manager, engine } = buildManager();

  manager.startExternalPlayback(
    1,
    'applemusic',
    { kind: 'url', url: 'https://example.invalid/known.m4a' },
    { title: 'Perfume', artist: '', album: '', duration: 240 },
    true,
  );

  const input = engine.lastStartArgs?.input as { knownDurationSec?: number } | undefined;
  assert.equal(input?.knownDurationSec, 240);
});

/*
 * The last hop, and the one that decides whether #350 is actually fixed rather than merely quieter.
 *
 * `ZonePlayer`'s clock is what ends a track and advances the queue. Removing the invented 120 means a
 * track can now start with no length at all — and a clock with no length never ends anything, so the
 * queue would sit on that track forever. What makes that safe is the length arriving later and the
 * clock being told: these two assert both halves, in that order.
 */
function playerWithSession(durationSec: number) {
  const session: any = {
    zoneId: 1,
    source: 'applemusic',
    duration: durationSec,
    metadata: { title: 'Perfume', artist: '', album: '' },
    playbackSource: { kind: 'url', url: 'https://example.invalid/track.m4a' },
    profiles: ['mp3'],
  };
  const audioManager: any = {
    startExternalPlayback: () => session,
    waitForFirstChunk: () => Promise.resolve(true),
    getSession: () => session,
    stopPlayback: () => session,
  };
  return { audioManager, session };
}

test('a clock with no length ends nothing — which is why the length has to be learned', async () => {
  const { audioManager, session } = playerWithSession(0);
  const player = new ZonePlayer(audioManager, 1, 'Zone', '00:00:00:00:00:00', false);

  let ended = 0;
  player.on('ended', () => {
    ended += 1;
  });
  player.playExternal('applemusic', session.playbackSource, session.metadata);

  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(player.getState().duration, 0, 'nothing was invented');
  assert.equal(ended, 0, 'and with nothing to end at, the clock runs on');

  player.stop();
});

test('a length learned mid-track reaches the clock and ends the track at it', async () => {
  const { audioManager, session } = playerWithSession(0);
  const player = new ZonePlayer(audioManager, 1, 'Zone', '00:00:00:00:00:00', false);

  let ended = 0;
  player.on('ended', () => {
    ended += 1;
  });
  player.playExternal('applemusic', session.playbackSource, session.metadata);
  await new Promise((resolve) => setTimeout(resolve, 400));

  // What `PlaybackCoordinator.applySourceDuration` does once ffmpeg has stated the length.
  player.updateTiming(0, 1);
  assert.equal(player.getState().duration, 1);

  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal(ended, 1, 'the track ends at its real length, so the queue advances');

  player.stop();
});
