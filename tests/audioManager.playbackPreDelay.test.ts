import assert from 'node:assert/strict';
import { test } from './testHarness';
import { AudioManager, type PlaybackSource } from '../src/application/playback/audioManager';
import { ZoneAudioPreferences } from '../src/application/playback/ZoneAudioPreferences';
import { PlaybackService } from '../src/application/playback/PlaybackService';
import type { EnginePort, EngineSessionStats } from '../src/ports/EnginePort';
import type { EngineStartOptions } from '../src/ports/EngineTypes';

class EngineSpy implements EnginePort {
  public lastStartOptions: EngineStartOptions | null = null;

  public start(...args: [EngineStartOptions] | [number, PlaybackSource, any?, any?]): void {
    if (typeof args[0] === 'object' && args[0] !== null && 'zoneId' in args[0]) {
      this.lastStartOptions = args[0] as EngineStartOptions;
      return;
    }
    throw new Error('unexpected start signature in test');
  }

  public startWithHandoff(...args: [EngineStartOptions] | [number, PlaybackSource, any?, any?, any?]): void {
    this.start(...(args as [EngineStartOptions]));
  }

  public stop(): void {}

  public createStream(): null {
    return null;
  }

  public createLocalSession(): any {
    return {
      start: () => {},
      stop: () => {},
      createSubscriber: () => null,
    };
  }

  public waitForFirstChunk(): Promise<boolean> {
    return Promise.resolve(false);
  }

  public hasSession(): boolean {
    return false;
  }

  public getSessionStats(): EngineSessionStats[] {
    return [];
  }

  public setSessionTerminationHandler(): void {}

  public restartZoneForEqualizer(): boolean {
    return false;
  }
}

const outputNotifier = {
  notifyOutputError: () => {},
  notifyOutputState: () => {},
};

test('audio manager applies zone playback pre-delay to external URL sources', () => {
  const engine = new EngineSpy();
  const service = new PlaybackService(engine);
  const prefs = new ZoneAudioPreferences();
  const manager = new AudioManager(service, outputNotifier, prefs);
  prefs.setPlaybackPreDelayMs(1, 1200);

  manager.startExternalPlayback(1, 'custom', { kind: 'url', url: 'https://example.com/stream.mp3' }, undefined, true);

  assert.equal(engine.lastStartOptions?.input.kind, 'url');
  assert.equal((engine.lastStartOptions?.input as any).preDelayMs, 1200);
});

test('audio manager keeps larger source pre-delay over zone playback pre-delay', () => {
  const engine = new EngineSpy();
  const service = new PlaybackService(engine);
  const prefs = new ZoneAudioPreferences();
  const manager = new AudioManager(service, outputNotifier, prefs);
  prefs.setPlaybackPreDelayMs(1, 600);

  manager.startExternalPlayback(
    1,
    'custom',
    { kind: 'file', path: '/tmp/test.mp3', preDelayMs: 1500 },
    undefined,
    true,
  );

  assert.equal(engine.lastStartOptions?.input.kind, 'file');
  assert.equal((engine.lastStartOptions?.input as any).preDelayMs, 1500);
});

test('audio manager skips zone playback pre-delay when zone power is already on', () => {
  const engine = new EngineSpy();
  const service = new PlaybackService(engine);
  const prefs = new ZoneAudioPreferences();
  const manager = new AudioManager(service, outputNotifier, prefs);
  prefs.setPlaybackPreDelayMs(1, 1200);
  prefs.setZonePowerStateResolver((zoneId) => zoneId === 1);

  manager.startExternalPlayback(1, 'custom', { kind: 'url', url: 'https://example.com/stream.mp3' }, undefined, true);

  assert.equal(engine.lastStartOptions?.input.kind, 'url');
  assert.equal((engine.lastStartOptions?.input as any).preDelayMs, undefined);
});

test('audio manager forces alert pre-delay floor even when zone power is already on', () => {
  const engine = new EngineSpy();
  const service = new PlaybackService(engine);
  const prefs = new ZoneAudioPreferences();
  const manager = new AudioManager(service, outputNotifier, prefs);
  // Amp is warm (would normally skip the delay), but a sibling cold zone forces
  // an alignment floor so this zone waits the same wake-up delay.
  prefs.setZonePowerStateResolver((zoneId) => zoneId === 1);
  prefs.setAlertPreDelayFloorMs(1, 2000);

  manager.startExternalPlayback(1, 'custom', { kind: 'url', url: 'https://example.com/stream.mp3' }, undefined, true);

  assert.equal(engine.lastStartOptions?.input.kind, 'url');
  assert.equal((engine.lastStartOptions?.input as any).preDelayMs, 2000);
});
