import assert from 'node:assert/strict';
import { test } from './testHarness';
import { AudioManager, type PlaybackSource } from '../src/application/playback/audioManager';
import { ZoneAudioPreferences } from '../src/application/playback/ZoneAudioPreferences';
import { PlaybackService } from '../src/application/playback/PlaybackService';
import type { EnginePort, EngineSessionStats } from '../src/ports/EnginePort';
import type { EngineStartOptions } from '../src/ports/EngineTypes';
import type { SessionKey } from '../src/ports/types/SessionKey';

// Issue #345: an output that drops its HTTP connection while paused (Sonos always does) leaves
// the session with zero subscribers. The resume has to restart the "actively driving" grace
// window, otherwise the first state patch from the speaker is read as a stale session and tears
// the engine down halfway through the resume.

class LiveEngine implements EnginePort {
  public subscribers = 0;

  public start(...args: [EngineStartOptions] | [SessionKey, PlaybackSource, any?, any?]): void {
    void args;
  }

  public startWithHandoff(...args: [EngineStartOptions] | [SessionKey, PlaybackSource, any?, any?, any?]): void {
    void args;
  }

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

  /** The engine survives the pause — that is what pausePlayback is for. */
  public hasSession(): boolean {
    return true;
  }

  public getSessionStats(): EngineSessionStats[] {
    return [{ subscribers: this.subscribers } as unknown as EngineSessionStats];
  }

  public setSessionTerminationHandler(): void {}

  public restartZoneForEqualizer(): boolean {
    return false;
  }

  public async inlineCrossfade(): Promise<boolean> {
    return false;
  }
}

function buildManager() {
  const engine = new LiveEngine();
  const manager = new AudioManager(
    new PlaybackService(engine),
    { notifyOutputError: () => {}, notifyOutputState: () => {}, notifySourceDuration: () => {} },
    new ZoneAudioPreferences(),
  );
  manager.startExternalPlayback(1, 'track', { kind: 'file', path: '/tmp/track.mp3' }, undefined, true);
  return { manager, engine };
}

test('pause keeps the session and its resume point', () => {
  const { manager, engine } = buildManager();
  engine.subscribers = 1;
  const started = manager.getSession(1);
  assert.ok(started);
  started.startedAt = Date.now() - 20_000;

  const paused = manager.pausePlayback(1);

  assert.equal(paused?.state, 'paused');
  assert.equal(manager.getSession(1)?.state, 'paused', 'the session is the resume point');
  assert.ok((paused?.elapsed ?? 0) >= 19, 'the position at the pause point is kept');
  assert.equal(manager.hasLocalEngineSession(1), true, 'the engine stays alive so resume can reuse it');
});

test('resume restarts the no-subscriber grace window so a state patch cannot kill it', () => {
  const { manager, engine } = buildManager();
  engine.subscribers = 1;
  const started = manager.getSession(1);
  assert.ok(started);
  // A track paused 20s in, whose timestamps are therefore all well outside the grace window.
  started.startedAt = Date.now() - 20_000;
  started.firstAudioReadyAt = Date.now() - 20_000;
  started.playbackStartedAt = Date.now() - 20_000;
  manager.pausePlayback(1);
  // The speaker disconnected while paused and has not come back yet.
  engine.subscribers = 0;

  const resumed = manager.resumePlayback(1);

  assert.equal(resumed?.state, 'playing');
  assert.equal(
    manager.hasActiveLocalSession(1),
    true,
    'a just-resumed session must not read as stale while the output reconnects',
  );
});

test('a stale playing session with no subscribers still reads as inactive', () => {
  // The counterpart: without a resume in between, the grace window must genuinely expire.
  const { manager, engine } = buildManager();
  engine.subscribers = 0;
  const session = manager.getSession(1);
  assert.ok(session);
  session.startedAt = Date.now() - 20_000;
  session.playbackStartedAt = Date.now() - 20_000;
  session.updatedAt = Date.now() - 20_000;

  assert.equal(manager.hasActiveLocalSession(1), false);
});
