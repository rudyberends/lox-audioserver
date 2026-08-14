import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { PlaybackSource } from '@/application/playback/audioManager';
import {
  SoloistSinkManager,
  SOLOIST_SINK_CHANNELS,
  SOLOIST_SINK_FORMAT,
  SOLOIST_SINK_RATE,
} from '@/adapters/inputs/spotify/soloist/soloistSinkManager';
import {
  isZonePaired,
  probeBinary,
  soloistDataDir,
  startPersistent,
  type SoloistRunHandle,
} from '@/adapters/inputs/spotify/soloist/soloistProcess';
import {
  readTrack,
  SoloistWsClient,
  type SoloistStateEvent,
} from '@/adapters/inputs/spotify/soloist/soloistWsClient';
import type { SpotifyConnectController } from '@/ports/InputsPort';
import type { PlaybackMetadata } from '@/application/playback/audioManager';

/** How long to wait for the track we asked for to actually be sounding. */
const PLAY_START_TIMEOUT_MS = 20_000;
/**
 * How much audio to look at before deciding how wide the samples really are.
 *
 * 2048 frames is under fifty milliseconds at 44.1 kHz — long enough to catch signal, short enough
 * that it does not show up as a delay before a track starts.
 */
const DEPTH_PROBE_FRAMES = 2048;

export type SoloistReadiness =
  | { ready: true }
  | { ready: false; reason: 'disabled' | 'no_api_key' | 'no_binary' | 'not_executable' | 'not_paired' };

/**
 * Who is deciding what plays.
 *
 * `queue` is this server working through its own list, one track at a time: a change to anything
 * else means the track ended. `connect` is someone driving the zone from the Spotify app, where
 * Soloist owns the queue and moving to the next track is ordinary — ending the session there
 * would cut off the very thing they asked for.
 */
type Owner = 'queue' | 'connect';

/** One zone's Soloist: the process, its control channel, and whatever it is playing. */
type ZoneRunner = {
  handle: SoloistRunHandle;
  ws: SoloistWsClient;
  owner: Owner;
  /** The track this zone was told to play, while the queue owns it. */
  wantedUri: string | null;
  /** What is sounding now, so a repeat of the same event is not treated as a change. */
  currentUri: string | null;
  stream: Readable | null;
};

/**
 * Plays Spotify through the user's own Soloist build instead of librespot.
 *
 * A second backend, not a replacement: librespot cannot obtain audio keys for accounts made after
 * Nov 2025, while Soloist costs a personal API key, a binary the user installs, and a build that
 * expires every 90 days. A zone picks one; absent a choice it stays on librespot.
 *
 * One process per zone, kept running and driven over its WebSocket. Per-track processes were the
 * first shape tried, and the data directory's lock rules them out: a zone gets one instance, and
 * wanting that zone to appear in the Spotify app means that instance must stay up. Driving the
 * running one costs no login per track and brings seeking and real events with it.
 */
export class SoloistPlaybackService {
  private readonly log = createLogger('Input', 'Soloist');
  private readonly sinks = new SoloistSinkManager();
  private readonly runners = new Map<number, ZoneRunner>();
  private readonly starting = new Map<number, Promise<ZoneRunner | null>>();
  /** Track lengths as Soloist reported them, so a position update can carry one. */
  private readonly durations = new Map<number, number>();

  private controller: SpotifyConnectController | null = null;

  constructor(private readonly configPort: ConfigPort) {}

  /**
   * The way back into the zone, for playback this server did not start.
   *
   * Everything routed through it rather than driven directly, so the ZoneManager's own check —
   * is spotify still this zone's input — can refuse an update from a room that has moved on.
   */
  public setController(controller: SpotifyConnectController): void {
    this.controller = controller;
  }

  private get settings() {
    return this.configPort.getConfig()?.content?.spotify?.soloist ?? {};
  }

  /** Whether Spotify plays through Soloist at all. One choice, for every zone. */
  public isEnabled(): boolean {
    return this.settings.enabled === true;
  }

  /**
   * Start a Soloist for every zone, so each one is a Connect device from the moment the server is.
   *
   * Eager on purpose. A zone with no process is not in the Spotify app's device list, so it can
   * neither be logged in nor taken over — and starting one is also how a zone gets logged in at
   * all: with no stored session it advertises and waits for someone to pick it. Lazily starting on
   * the first play would mean a room could only be reached from a phone after it had already been
   * played from here, which is backwards.
   */
  public async syncZones(zoneIds: number[]): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }
    const wanted = new Set(zoneIds);
    // A zone that no longer does Spotify must stop appearing in the device list, which means its
    // process has to go — there is no way to run Soloist without it advertising itself.
    for (const [zoneId, runner] of [...this.runners]) {
      if (!wanted.has(zoneId)) {
        this.log.info('zone no longer does spotify; stopping its soloist', { zoneId });
        this.finishTrack(zoneId);
        runner.ws.close();
        runner.handle.stop();
        this.runners.delete(zoneId);
        await this.sinks.removeSink(zoneId);
      }
    }
    for (const zoneId of wanted) {
      await this.ensureRunner(zoneId).catch(() => null);
    }
  }

  /** Stop every zone's Soloist, for when the backend is switched off. */
  public async stopAllZones(): Promise<void> {
    for (const [zoneId, runner] of [...this.runners]) {
      this.finishTrack(zoneId);
      runner.ws.close();
      runner.handle.stop();
      this.runners.delete(zoneId);
    }
  }

  /** Everything that has to be true before a zone can play, named so the UI can say which is not. */
  public async readiness(zoneId: number): Promise<SoloistReadiness> {
    if (this.settings.enabled !== true) {
      return { ready: false, reason: 'disabled' };
    }
    if (!this.settings.apiKey?.trim()) {
      return { ready: false, reason: 'no_api_key' };
    }
    const binary = await probeBinary();
    if (!binary.present) {
      return { ready: false, reason: 'no_binary' };
    }
    if (!binary.executable) {
      return { ready: false, reason: 'not_executable' };
    }
    if (!(await isZonePaired(zoneId))) {
      // The process runs and advertises regardless; what it cannot do yet is be told what to play.
      return { ready: false, reason: 'not_paired' };
    }
    return { ready: true };
  }

  private zoneName(zoneId: number): string {
    const zone = this.configPort.getConfig()?.zones?.find((z) => z.id === zoneId);
    return zone?.name?.trim() || `Sonn Zone ${zoneId}`;
  }

  /** Start this zone's Soloist and connect to it, or return the one already running. */
  private async ensureRunner(zoneId: number): Promise<ZoneRunner | null> {
    const existing = this.runners.get(zoneId);
    if (existing) {
      return existing;
    }
    const inFlight = this.starting.get(zoneId);
    if (inFlight) {
      return inFlight;
    }
    const promise = this.startRunner(zoneId).finally(() => this.starting.delete(zoneId));
    this.starting.set(zoneId, promise);
    return promise;
  }

  private async startRunner(zoneId: number): Promise<ZoneRunner | null> {
    const apiKey = this.settings.apiKey?.trim();
    if (!apiKey) {
      return null;
    }
    if (!(await this.sinks.ensureSink(zoneId))) {
      return null;
    }

    // Clear the port file first. Soloist writes it once it is listening, so a leftover from the
    // previous run is read as this one's address — the connection is refused, and the process that
    // was about to publish the real port gets killed for it.
    await fsp.rm(path.join(soloistDataDir(zoneId), 'ws.port'), { force: true }).catch(() => undefined);

    const handle = startPersistent({
      zoneId,
      apiKey,
      deviceName: this.zoneName(zoneId),
      env: this.sinks.childEnv(zoneId),
    });
    void handle.expiresInDays.then((days) => {
      if (typeof days === 'number') {
        void this.recordExpiry(days);
      }
    });

    const ws = new SoloistWsClient(zoneId, soloistDataDir(zoneId));
    if (!(await ws.connect())) {
      handle.stop();
      return null;
    }
    // Deliberately not waiting for a login here. A zone that has never been signed in never
    // reports one — it is sitting there advertising itself, which is the only way it can ever be
    // signed in. Requiring it first killed exactly the process that was waiting to be picked, so
    // such a zone could never appear in the Spotify app at all.

    const runner: ZoneRunner = {
      handle,
      ws,
      owner: 'queue',
      wantedUri: null,
      currentUri: null,
      stream: null,
    };
    ws.on('event', (event: SoloistStateEvent) => this.onEvent(zoneId, event));
    // If the process dies the control channel goes with it; drop the runner so the next play
    // starts a fresh one rather than talking into a closed socket.
    void handle.done.then(() => {
      this.log.info('soloist exited; zone will restart it on the next track', { zoneId });
      ws.close();
      this.finishTrack(zoneId);
      this.runners.delete(zoneId);
    });

    this.runners.set(zoneId, runner);
    this.log.info('soloist running for zone', { zoneId });
    return runner;
  }

  /**
   * Watch for the track we asked for going away.
   *
   * Soloist keeps its own queue and moves on by itself when a track ends, so there is no "finished"
   * event to wait for — what arrives is a `track_changed` naming something nobody asked for. That
   * is the end of our track, and ending the stream is what turns it into the EOF the engine already
   * advances on.
   */
  private onEvent(zoneId: number, event: SoloistStateEvent): void {
    const runner = this.runners.get(zoneId);
    if (!runner) {
      return;
    }
    const track = readTrack(event.item);
    const uri = track.uri;

    if (event.type === 'track_changed' && uri) {
      if (runner.owner === 'queue' && runner.wantedUri && uri !== runner.wantedUri) {
        // Our track finished and Soloist moved on by itself; the queue picks the next one.
        this.log.debug('soloist moved past our track; ending the stream', {
          zoneId,
          expected: runner.wantedUri,
          got: uri,
        });
        runner.ws.pause();
        this.finishTrack(zoneId);
        return;
      }
      if (runner.owner === 'connect' && uri !== runner.currentUri) {
        // The app moved to its own next track. The stream carries on; only the labels change.
        runner.currentUri = uri;
        this.publishTrack(zoneId, track);
        return;
      }
    }

    if (event.status === 'playing') {
      // Only when this device is the one sounding. Connect pushes the account's playback to every
      // device it has, so an idle room reports the same track, status and position as the room
      // actually playing — adopting on that would light up every room at once with the same song.
      if (!runner.ws.isActive) {
        return;
      }
      // Playing something nobody here asked for means the zone was taken over from the Spotify
      // app. Adopting it is the whole of Connect: open the pipe and let the zone follow along.
      const ours = runner.owner === 'queue' && runner.wantedUri && uri === runner.wantedUri;
      if (!ours && uri && uri !== runner.currentUri) {
        void this.adoptConnectPlayback(zoneId, event);
      }
      return;
    }

    // Handed off to another device: this room is no longer the one playing, whatever else the
    // account's state says about the track.
    if (runner.owner === 'connect' && !runner.ws.isActive) {
      this.log.info('spotify moved playback to another device', { zoneId });
      runner.owner = 'queue';
      runner.currentUri = null;
      this.finishTrack(zoneId);
      this.controller?.stopPlayback(zoneId);
      return;
    }

    if (runner.owner !== 'connect') {
      return;
    }
    if (event.status === 'paused') {
      this.controller?.pausePlayback(zoneId);
      return;
    }
    if (event.status === 'idle' || event.status === 'stopped') {
      this.log.info('the spotify app stopped this zone', { zoneId });
      runner.owner = 'queue';
      runner.currentUri = null;
      this.finishTrack(zoneId);
      this.controller?.stopPlayback(zoneId);
      return;
    }
    if (event.type === 'position_sync' && typeof event.position?.position_ms === 'number') {
      const elapsed = Math.max(0, Math.round(event.position.position_ms / 1000));
      // Zero arrives on every track change, where the timer has already been reset; forwarding it
      // would hold the clock at the start of a track that is already running.
      if (elapsed > 0) {
        this.controller?.updateTiming(zoneId, elapsed, this.durations.get(zoneId) ?? 0);
      }
    }
  }

  /**
   * Follow playback that started in the Spotify app.
   *
   * The zone is a Connect device whenever its Soloist is up, so this can happen at any moment and
   * without warning. All it takes is reading the pipe that is already there and telling the zone
   * what is on it — the audio path is the same one the queue uses.
   */
  private async adoptConnectPlayback(zoneId: number, event: SoloistStateEvent): Promise<void> {
    const runner = this.runners.get(zoneId);
    if (!runner) {
      return;
    }
    const track = readTrack(event.item);
    runner.owner = 'connect';
    runner.currentUri = track.uri ?? null;
    runner.wantedUri = null;

    if (!runner.stream) {
      const stream = await this.openFifo(this.sinks.fifoPathFor(zoneId));
      if (!stream) {
        return;
      }
      runner.stream = stream;
      this.log.info('the spotify app took this zone over', { zoneId, uri: track.uri });
      this.controller?.startPlayback(
        zoneId,
        'spotify-connect',
        this.pipeSourceFor(zoneId, stream, await this.probeDepth(stream)),
        this.metadataFor(track),
      );
      return;
    }
    this.publishTrack(zoneId, track);
  }

  private publishTrack(zoneId: number, track: ReturnType<typeof readTrack>): void {
    const metadata = this.metadataFor(track);
    this.controller?.updateMetadata(zoneId, metadata);
    if (typeof track.durationSec === 'number') {
      this.durations.set(zoneId, track.durationSec);
      this.controller?.updateTiming(zoneId, 0, track.durationSec);
    }
  }

  private metadataFor(track: ReturnType<typeof readTrack>): PlaybackMetadata {
    return {
      title: track.title ?? '',
      artist: track.artist ?? '',
      album: track.album ?? '',
      coverurl: track.coverUrl,
      duration: track.durationSec,
      audiopath: track.uri,
    };
  }

  /** End the engine's view of the current track without touching the process. */
  private finishTrack(zoneId: number): void {
    const runner = this.runners.get(zoneId);
    if (!runner) {
      return;
    }
    runner.wantedUri = null;
    const stream = runner.stream;
    runner.stream = null;
    stream?.destroy();
  }

  /**
   * Start a track and hand back the FIFO the engine should read.
   *
   * Not `realTime`: the sink is clocked, so the pacing is already upstream, and adding ffmpeg's
   * `-re` puts a second timer on the same stream — which stutters against a pipe buffer far too
   * small to absorb the disagreement.
   */
  public async getPlaybackSource(
    zoneId: number,
    uri: string,
    seekPositionMs = 0,
  ): Promise<PlaybackSource | null> {
    const ready = await this.readiness(zoneId);
    if (!ready.ready) {
      this.log.warn('soloist cannot play this zone yet', { zoneId, reason: ready.reason });
      return null;
    }
    const runner = await this.ensureRunner(zoneId);
    if (!runner) {
      return null;
    }
    // Here it matters: a command sent before the session is restored comes back refused rather
    // than queued. The zone is signed in — readiness said so — so this is only about timing.
    if (!(await runner.ws.waitUntilReady())) {
      this.log.warn('soloist has not finished logging in', { zoneId });
      return null;
    }

    // Whatever was sounding is over as far as the engine is concerned, and this server is
    // deciding again — even if the app had taken the zone over a moment ago.
    this.finishTrack(zoneId);
    runner.owner = 'queue';
    runner.wantedUri = uri;
    runner.currentUri = uri;

    const playing = this.waitForPlaying(runner, uri);
    if (!runner.ws.play(uri)) {
      this.log.warn('could not reach soloist to start the track', { zoneId, uri });
      return null;
    }
    if (!(await playing)) {
      this.log.warn('soloist did not start playing this track', { zoneId, uri });
      runner.wantedUri = null;
      return null;
    }
    if (seekPositionMs > 0) {
      runner.ws.seek(seekPositionMs);
    }

    const fifoPath = this.sinks.fifoPathFor(zoneId);
    const stream = await this.openFifo(fifoPath);
    if (!stream) {
      return null;
    }
    runner.stream = stream;
    return this.pipeSourceFor(zoneId, stream, await this.probeDepth(stream));
  }

  /**
   * The zone's pipe, however playback came about.
   *
   * Not `realTime`: the sink is clocked, so the pacing is already upstream, and adding ffmpeg's
   * `-re` puts a second timer on the same stream — which stutters against a pipe buffer far too
   * small to absorb the disagreement. The format must match the sink exactly, pinned to what
   * Spotify lossless is so nothing converts on the way in.
   */
  private pipeSourceFor(zoneId: number, stream: Readable, bitDepth?: 16 | 24): PlaybackSource {
    return {
      kind: 'pipe',
      path: `soloist-${zoneId}`,
      format: SOLOIST_SINK_FORMAT,
      bitDepth,
      sampleRate: SOLOIST_SINK_RATE,
      channels: SOLOIST_SINK_CHANNELS,
      realTime: false,
      stream,
    };
  }

  private waitForPlaying(runner: ZoneRunner, uri: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        runner.ws.off('event', onEvent);
        clearTimeout(timer);
        resolve(ok);
      };
      const onEvent = (event: SoloistStateEvent): void => {
        // `playing` alone is not enough: it also arrives for whatever was sounding before ours
        // started. The status has to be accompanied by our own uri.
        if (event.status === 'playing' && (!event.item?.uri || event.item.uri === uri)) {
          finish(true);
        }
      };
      const timer = setTimeout(() => finish(false), PLAY_START_TIMEOUT_MS);
      runner.ws.on('event', onEvent);
    });
  }

  /**
   * How many bits of each sample carry anything.
   *
   * Everything Soloist decodes leaves it as float and arrives here in 24-bit words, so the pipe
   * cannot say whether a track is a 24-bit master or a 16-bit one padded out — and most of
   * Spotify's catalogue is the latter. The samples themselves can: a 16-bit value scaled into 24
   * bits is an exact multiple of 256, so its low byte is always zero. Nothing in this chain fills
   * those bits either, since there is no gain, no resample and no dither ahead of us.
   *
   * Silence is not evidence, so a quiet opening yields nothing rather than a wrong answer.
   */
  private static measureDepth(pcm: Buffer): 16 | 24 | undefined {
    let lowByte = 0;
    let anything = 0;
    for (let i = 0; i + 2 < pcm.length; i += 3) {
      lowByte |= pcm[i]!;
      anything |= pcm[i]! | pcm[i + 1]! | pcm[i + 2]!;
    }
    if (!anything) {
      return undefined;
    }
    return lowByte === 0 ? 16 : 24;
  }

  /** Read a little audio to measure it, then put it back so nothing is lost from the track. */
  private async probeDepth(stream: Readable): Promise<16 | 24 | undefined> {
    const need = DEPTH_PROBE_FRAMES * SOLOIST_SINK_CHANNELS * 3;
    const chunks: Buffer[] = [];
    let total = 0;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        stream.off('data', onData);
        stream.pause();
        resolve();
      };
      const onData = (chunk: Buffer): void => {
        chunks.push(chunk);
        total += chunk.length;
        if (total >= need) {
          done();
        }
      };
      const timer = setTimeout(done, 1_000);
      stream.on('data', onData);
    });
    if (!total) {
      return undefined;
    }
    const prefix = Buffer.concat(chunks);
    stream.unshift(prefix);
    return SoloistPlaybackService.measureDepth(prefix);
  }

  /**
   * Opening a FIFO read-only blocks until a writer shows up. Read-write never blocks and behaves
   * identically here; the handle is owned so the descriptor is given back rather than collected.
   */
  private async openFifo(fifoPath: string): Promise<Readable | null> {
    try {
      const handle = await fsp.open(fifoPath, 'r+');
      const stream = createReadStream(fifoPath, { fd: handle.fd, autoClose: false });
      const close = (): void => {
        void handle.close().catch(() => undefined);
      };
      stream.once('close', close);
      stream.once('error', close);
      return stream;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('could not open the soloist fifo', { fifoPath, message });
      return null;
    }
  }

  public async stopZone(zoneId: number, reason = 'stop'): Promise<void> {
    const runner = this.runners.get(zoneId);
    if (!runner) {
      return;
    }
    this.log.debug('stopping soloist playback for zone', { zoneId, reason });
    runner.ws.pause();
    // Hand the account's playback back rather than keeping it pinned to a room that stopped
    // listening; the process stays up so the zone remains pickable in the Spotify app.
    runner.ws.deactivate();
    this.finishTrack(zoneId);
  }

  public isPlaying(zoneId: number): boolean {
    return Boolean(this.runners.get(zoneId)?.stream);
  }

  /** Keep the reported expiry fresh so the admin screen can warn before a build stops working. */
  private async recordExpiry(daysAtCheck: number): Promise<void> {
    const existing = this.settings.expiry;
    if (existing && existing.daysAtCheck === daysAtCheck && Date.now() - existing.checkedAt < 12 * 3600_000) {
      return;
    }
    try {
      await this.configPort.updateConfig((cfg) => {
        const spotify = cfg.content?.spotify;
        if (!spotify) {
          return;
        }
        spotify.soloist = { ...(spotify.soloist ?? {}), expiry: { daysAtCheck, checkedAt: Date.now() } };
      });
    } catch {
      /* best effort; the figure is a convenience, not state anything depends on */
    }
  }

  public async shutdown(): Promise<void> {
    for (const [zoneId, runner] of [...this.runners]) {
      this.finishTrack(zoneId);
      runner.ws.close();
      runner.handle.stop();
    }
    this.runners.clear();
    await this.sinks.stop();
  }

  /** Exposed so the pairing endpoint can reach the same sink environment. */
  public sinkEnvFor(zoneId: number): Record<string, string> {
    return this.sinks.childEnv(zoneId);
  }

  public dataDirFor(zoneId: number): string {
    return soloistDataDir(zoneId);
  }
}
