import 'tsconfig-paths/register';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

type TestFn = () => void | Promise<void>;

const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });

class FakeProcess extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly stdin = new PassThrough();
  public killed = false;
  public readonly signals: string[] = [];

  constructor(private readonly exitOnKill: boolean) {
    super();
  }

  public kill(signal: string): boolean {
    this.signals.push(signal);
    if (signal === 'SIGKILL') {
      this.killed = true;
    }
    if (this.exitOnKill && signal === 'SIGTERM') {
      this.emit('exit', 0, null);
    }
    return true;
  }

  public removeAllListeners(): this {
    super.removeAllListeners();
    return this;
  }
}

const childProcess = require('node:child_process') as {
  spawn: (...args: any[]) => FakeProcess;
};
const originalSpawn = childProcess.spawn;
let spawnImpl: (...args: any[]) => FakeProcess = () => new FakeProcess(true);
childProcess.spawn = (...args: any[]) => spawnImpl(...args);

const { AudioSession } = require('../src/modules/audio/engine/audioSession') as typeof import('../src/modules/audio/engine/audioSession');
const { audioOutputSettings } = require('../src/modules/audio/utils/audioFormat') as typeof import('../src/modules/audio/utils/audioFormat');

test('audio session stats report zero subscribers', () => {
  const session = new AudioSession(
    1,
    { kind: 'file', path: '/tmp/fake.wav' },
    'mp3',
    () => undefined,
    audioOutputSettings,
  );
  const stats = session.getStats();
  assert.equal(stats.subscribers, 0);
});

test('pipe source listeners are detached after stop', () => {
  const source = new PassThrough();
  const baseDataListeners = source.listenerCount('data');
  const baseErrorListeners = source.listenerCount('error');
  spawnImpl = () => new FakeProcess(true);
  const session = new AudioSession(
    1,
    { kind: 'pipe', path: '/tmp/fake.pcm', stream: source },
    'pcm',
    () => undefined,
    audioOutputSettings,
  );
  session.start();
  assert.ok(source.listenerCount('data') > baseDataListeners);
  assert.ok(source.listenerCount('error') > baseErrorListeners);
  session.stop();
  assert.equal(source.listenerCount('data'), baseDataListeners);
  assert.equal(source.listenerCount('error'), baseErrorListeners);
});

test('ffmpeg stop issues SIGKILL after timeout', async () => {
  const source = new PassThrough();
  let proc: FakeProcess | null = null;
  process.env.AUDIO_FFMPEG_KILL_MS = '50';
  spawnImpl = () => {
    proc = new FakeProcess(false);
    return proc;
  };
  const session = new AudioSession(
    1,
    { kind: 'pipe', path: '/tmp/fake.pcm', stream: source },
    'pcm',
    () => undefined,
    audioOutputSettings,
  );
  session.start();
  session.stop();
  await new Promise((resolve) => setTimeout(resolve, 80));
  if (!proc) {
    throw new Error('ffmpeg process not captured');
  }
  const captured = proc as unknown as { signals: string[] };
  assert.deepEqual(captured.signals, ['SIGTERM', 'SIGKILL']);
});

async function run(): Promise<void> {
  let failures = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
    }
  }
  childProcess.spawn = originalSpawn;
  if (failures > 0) {
    process.exitCode = 1;
  }
}

void run();
