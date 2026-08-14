import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '@/shared/logging/logger';
import { resolveDataDir } from '@/shared/utils/file';

const execFileAsync = promisify(execFile);

/**
 * Pinned to what Spotify lossless actually is: 24-bit, 44.1 kHz.
 *
 * The rate matters because anything else — 48 kHz in particular — puts a resampler we do not
 * control between the decoder and our own DSP chain.
 *
 * The depth is the ceiling, not a guess. Soloist hands over `float32le`, having normalised whatever
 * it decoded, so the recording's own depth is already gone by the time it reaches us; what can be
 * said is that nothing above 24 bits can exist in it. A 24-bit integer survives that float round
 * trip exactly (a float32 mantissa is 24 bits) as long as nothing scales it, which is why this
 * backend leaves Soloist's own volume at unity. Carrying it in a 32-bit container would lose
 * nothing either, but it would make the signal path claim a resolution that was never there.
 */
export const SOLOIST_SINK_RATE = 44100;
export const SOLOIST_SINK_FORMAT = 's24le';
export const SOLOIST_SINK_CHANNELS = 2;

/**
 * The virtual sinks Soloist plays into, and the sound server they live in.
 *
 * Soloist writes to PipeWire or PulseAudio and nothing else — no pipe, no file, no stdout — so a
 * sound server is unavoidable. What it does not have to be is heavy: this runs one PulseAudio with
 * hardware detection, dbus and the session manager all left out, and adds a `module-pipe-sink` per
 * zone. One daemon serves every zone (measured at ~7 MB); each extra zone is a module and a FIFO,
 * not another process.
 *
 * The sink is clocked (`use_system_clock_for_timing`). Left to itself a pipe-sink has no notion of
 * time and empties into the FIFO as fast as the reader will take it, which reaches the engine in
 * lumps rather than a stream. Clocked, it behaves like any other live source — which is also why
 * the playback source does not ask ffmpeg for `-re`: the pacing is already here, and a second timer
 * on top only fights this one.
 */
export class SoloistSinkManager {
  private readonly log = createLogger('Audio', 'SoloistSink');
  private daemon: ChildProcess | null = null;
  private starting: Promise<boolean> | null = null;
  /**
   * True when the daemon answering us was started by an earlier run rather than by this process.
   *
   * It outlives a server restart — which is welcome, since a zone keeps its sink — but it means we
   * did not spawn it and must not try to, nor kill it on the way out.
   */
  private adopted = false;
  /** zoneId → the pactl module index that owns its sink, so it can be unloaded again. */
  private readonly modules = new Map<number, string>();

  private get runtimeDir(): string {
    return resolveDataDir('soloist', 'run');
  }

  public fifoPathFor(zoneId: number): string {
    return path.join(this.runtimeDir, `zone-${zoneId}.fifo`);
  }

  public sinkNameFor(zoneId: number): string {
    return `sonn_zone_${zoneId}`;
  }

  /** The environment a Soloist child needs to reach this daemon and land in the right sink. */
  public childEnv(zoneId: number): Record<string, string> {
    return {
      PULSE_RUNTIME_PATH: this.runtimeDir,
      PULSE_SINK: this.sinkNameFor(zoneId),
    };
  }

  public isRunning(): boolean {
    return this.adopted || Boolean(this.daemon && this.daemon.exitCode === null);
  }

  /**
   * Start the sound server if it is not up. Returns false when PulseAudio is not installed, which
   * is a configuration problem rather than a fault — the caller reports it and stays on librespot.
   */
  public async ensureDaemon(): Promise<boolean> {
    if (this.isRunning()) {
      return true;
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.startDaemon().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startDaemon(): Promise<boolean> {
    const dir = this.runtimeDir;
    await fsp.mkdir(dir, { recursive: true });

    // Ask before spawning. A daemon from a previous run of this server is still there after a
    // restart, and spawning over it fails with "Daemon already running" — which used to leave the
    // manager thinking it had no sound server while one was answering perfectly well, so no zone
    // could resolve a source until something restarted it.
    if (await this.probeDaemon()) {
      this.adopted = true;
      this.log.info('reusing the sound server left by an earlier run');
      return true;
    }

    const scriptPath = path.join(dir, 'default.pa');
    const configPath = path.join(dir, 'daemon.conf');
    // Only the unix socket. No `module-udev-detect` (nothing to detect and nothing we want it to
    // find), no `module-suspend-on-idle` (a suspended sink stalls the FIFO), no dbus.
    await fsp.writeFile(scriptPath, 'load-module module-native-protocol-unix\n', 'utf8');
    await fsp.writeFile(
      configPath,
      [
        'exit-idle-time = -1',
        'flat-volumes = no',
        // Belt and braces around the pinned sink format: nothing may resample on the way in.
        'avoid-resampling = yes',
        'resample-method = copy',
        `default-sample-format = ${SOLOIST_SINK_FORMAT}`,
        `default-sample-rate = ${SOLOIST_SINK_RATE}`,
        `alternate-sample-rate = ${SOLOIST_SINK_RATE}`,
        `default-sample-channels = ${SOLOIST_SINK_CHANNELS}`,
        '',
      ].join('\n'),
      'utf8',
    );

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };
      let child: ChildProcess;
      try {
        child = spawn(
          'pulseaudio',
          ['--daemonize=no', '-n', '-F', scriptPath, '--exit-idle-time=-1'],
          {
            env: {
              ...process.env,
              PULSE_RUNTIME_PATH: dir,
              PULSE_CONFIG_PATH: dir,
              // Point the session bus at nothing that exists.
              //
              // PulseAudio claims `org.PulseAudio1` on whatever bus it can reach and treats the
              // name being taken as another daemon of its own — it refuses to start. On a machine
              // with a desktop session that name is already held by the session's own PulseAudio,
              // which has nothing to do with ours: different socket, different config, none of our
              // sinks. So after a reboot every room silently disappeared from the Spotify app.
              // Unreachable it merely warns, and a private daemon has no use for a bus anyway.
              DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(dir, 'no-dbus')}`,
            },
            stdio: ['ignore', 'ignore', 'pipe'],
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('pulseaudio could not be started', { message });
        finish(false);
        return;
      }

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim();
        if (text) {
          this.log.debug('pulseaudio', { message: text.slice(0, 300) });
        }
      });
      child.on('error', (error) => {
        this.log.warn('pulseaudio is not available; the soloist backend needs it', {
          message: error.message,
        });
        this.daemon = null;
        finish(false);
      });
      child.on('exit', (code, signal) => {
        this.log.info('pulseaudio stopped', { code, signal });
        this.daemon = null;
        this.modules.clear();
        finish(false);
      });

      this.daemon = child;
      // No readiness signal on stdout, so confirm by asking it something.
      const waitReady = async (): Promise<void> => {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await new Promise((r) => setTimeout(r, 250));
          try {
            await this.pactl(['info']);
            this.log.info('soloist sound server ready');
            finish(true);
            return;
          } catch {
            /* not up yet */
          }
        }
        this.log.warn('pulseaudio did not become ready');
        finish(false);
      };
      void waitReady();
    });
  }

  private async probeDaemon(): Promise<boolean> {
    try {
      await this.pactl(['info']);
      return true;
    } catch {
      return false;
    }
  }

  private async pactl(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('pactl', args, {
      env: { ...process.env, PULSE_RUNTIME_PATH: this.runtimeDir },
      timeout: 5000,
    });
    return stdout;
  }

  /**
   * Make sure this zone has a sink writing into its own FIFO, and return that path.
   *
   * The FIFO is recreated whenever the module is loaded so a stale one from a previous run — which
   * may still have a dead reader attached — cannot silently swallow the stream.
   */
  public async ensureSink(zoneId: number): Promise<string | null> {
    if (!(await this.ensureDaemon())) {
      return null;
    }
    const fifoPath = this.fifoPathFor(zoneId);
    // Always ask the daemon, never this map. It is a record of what we did, not of what is there:
    // it survives a sink being unloaded by anything else, and after a restart it starts empty while
    // the daemon still holds everything. Trusting it handed out the path to a sink that no longer
    // existed, and the zone then failed on a missing FIFO at every track. A listing per track start
    // costs a few milliseconds and cannot be wrong.
    await this.dropDuplicateSinks(zoneId);
    if (await this.sinkExists(zoneId)) {
      // A sink is only usable together with its pipe. Unloading a module takes the FIFO with it,
      // and a duplicate shares the path with the original — so clearing one can leave a sink
      // standing over a file that no longer exists, which shows up as ENOENT at the next track.
      if (await this.fifoExists(fifoPath)) {
        this.log.debug('reusing the sink already in the sound server', { zoneId, fifoPath });
        this.modules.set(zoneId, 'adopted');
        return fifoPath;
      }
      this.log.info('the sink lost its pipe; rebuilding it', { zoneId, fifoPath });
      await this.unloadSinkByName(this.sinkNameFor(zoneId));
    }
    try {
      await fsp.mkdir(path.dirname(fifoPath), { recursive: true });
      await fsp.rm(fifoPath, { force: true });
      const index = await this.pactl([
        'load-module',
        'module-pipe-sink',
        `sink_name=${this.sinkNameFor(zoneId)}`,
        `file=${fifoPath}`,
        `format=${SOLOIST_SINK_FORMAT}`,
        `rate=${SOLOIST_SINK_RATE}`,
        `channels=${SOLOIST_SINK_CHANNELS}`,
        // Without this the sink has no clock at all: it hands over samples the moment the reader
        // has room, which measured at gigabytes per second and arrived at the engine in lumps —
        // 39 ms of average jitter on 25 ms chunks, peaks past 100 ms, and audible stutter however
        // the far end was paced. With it the writes follow the system clock and the FIFO behaves
        // like the live source it is meant to be (measured 364 kB/s against a nominal 353).
        'use_system_clock_for_timing=yes',
      ]);
      this.modules.set(zoneId, index.trim());
      this.log.info('soloist sink ready', { zoneId, fifoPath });
      return fifoPath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('could not create the soloist sink for this zone', { zoneId, message });
      return null;
    }
  }

  private async listSinkNames(): Promise<string[]> {
    try {
      const listing = await this.pactl(['list', 'sinks', 'short']);
      return listing
        .split('\n')
        .map((line) => line.split('\t')[1])
        .filter((name): name is string => Boolean(name));
    } catch {
      return [];
    }
  }

  private async sinkExists(zoneId: number): Promise<boolean> {
    return (await this.listSinkNames()).includes(this.sinkNameFor(zoneId));
  }

  /**
   * Unload the `<name>.2`, `<name>.3` … sinks a name collision leaves behind.
   *
   * They point at the same FIFO as the original, so the zone ends up with two writers on one pipe
   * and audio only appears once the reader happens to be fed by the sink Soloist chose — which
   * looked like a fifteen-second silence at the start of every track.
   */
  private async dropDuplicateSinks(zoneId: number): Promise<void> {
    const base = this.sinkNameFor(zoneId);
    const duplicates = (await this.listSinkNames()).filter((name) =>
      new RegExp(`^${base}\\.\\d+$`).test(name),
    );
    for (const name of duplicates) {
      await this.unloadSinkByName(name);
      this.log.info('removed a duplicate sink', { zoneId, name });
    }
  }

  private async unloadSinkByName(name: string): Promise<void> {
    try {
      await this.pactl(['unload-module', await this.moduleIndexForSink(name)]);
    } catch {
      /* nothing to unload, or already gone */
    }
  }

  private async fifoExists(fifoPath: string): Promise<boolean> {
    try {
      const stat = await fsp.stat(fifoPath);
      return stat.isFIFO();
    } catch {
      return false;
    }
  }

  private async moduleIndexForSink(name: string): Promise<string> {
    const listing = await this.pactl(['list', 'sinks']);
    // Blocks are separated by a blank line; the owner module lives in the same block as the name.
    for (const block of listing.split('\n\n')) {
      if (block.includes(`Name: ${name}\n`)) {
        const owner = /Owner Module:\s*(\d+)/.exec(block)?.[1];
        if (owner) {
          return owner;
        }
      }
    }
    throw new Error(`no owner module for sink ${name}`);
  }

  public async removeSink(zoneId: number): Promise<void> {
    const index = this.modules.get(zoneId);
    if (!index) {
      return;
    }
    this.modules.delete(zoneId);
    if (index === 'adopted') {
      // Not ours to unload, and the FIFO belongs to whoever is still holding it open.
      return;
    }
    try {
      await this.pactl(['unload-module', index]);
    } catch {
      /* the daemon may already be gone; the sink goes with it either way */
    }
    await fsp.rm(this.fifoPathFor(zoneId), { force: true }).catch(() => undefined);
  }

  public async stop(): Promise<void> {
    for (const zoneId of [...this.modules.keys()]) {
      await this.removeSink(zoneId);
    }
    const child = this.daemon;
    this.daemon = null;
    // Only stop what we started. An adopted daemon may be serving zones this process never touched.
    if (!this.adopted && child && child.exitCode === null) {
      child.kill();
    }
    this.adopted = false;
  }
}
