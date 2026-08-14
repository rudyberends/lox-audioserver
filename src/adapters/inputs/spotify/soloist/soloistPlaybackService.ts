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
  applyPreferences,
  isZonePaired,
  probeBinary,
  soloistDataDir,
  startPersistent,
  type SoloistRunHandle,
} from '@/adapters/inputs/spotify/soloist/soloistProcess';
import {
  readTrack,
  SoloistWsClient,
  type SoloistQueueEntry,
  type SoloistStateEvent,
} from '@/adapters/inputs/spotify/soloist/soloistWsClient';
import type { SpotifyConnectController, SpotifyQueueTrack } from '@/ports/InputsPort';
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
/** How long to keep waiting for audible samples before giving up on measuring at all. */
const DEPTH_PROBE_TIMEOUT_MS = 3_000;

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
  /** The current track in full, since the queue Soloist reports leaves it out. */
  currentTrack: SpotifyQueueTrack | null;
  /** Either side of the current track, as Soloist last reported it. */
  queue: { previous: string[]; upcoming: string[] };
  /** Whether the app's pause is what stopped this zone, so its resume can start it again. */
  appPaused: boolean;
  /**
   * Whether a track is being set up right now.
   *
   * Taking the account makes Soloist start whatever the account was playing, a moment before it is
   * told what this room actually wants. Read as ordinary events, that is a foreign track arriving
   * out of nowhere — a skip, or a takeover — so nothing is read at all until the new track is on.
   */
  starting: boolean;
  stream: Readable | null;
};

/**
 * What a track change means when this server owns the queue.
 *
 * Soloist keeps a queue of its own whatever we do with it, so a track we did not ask for is either
 * our own track ending — it moves on by itself — or someone reaching for the app's buttons. The two
 * are told apart by where the new track sits: going back plays something Soloist has already
 * played, and that is the only case the queue here must be walked backwards for.
 */
export function classifyTrackChange(
  uri: string,
  wantedUri: string | null,
  queue: { previous: string[] },
): 'ours' | 'back' | 'forward' {
  if (!wantedUri || uri === wantedUri) {
    return 'ours';
  }
  return queue.previous.includes(uri) ? 'back' : 'forward';
}

function urisOf(entries: SoloistQueueEntry[] | undefined): string[] {
  return (entries ?? [])
    .map((entry) => entry?.item?.uri)
    .filter((uri): uri is string => Boolean(uri));
}

/**
 * The app's queue with the current track put back where it belongs.
 *
 * `queue_changed` names what has been played and what is to come but not what is playing, so
 * mirroring it verbatim would leave a gap at exactly the place a listener looks first — and the
 * zone would have nothing to anchor its own position to.
 */
export function buildMirroredQueue(
  current: SpotifyQueueTrack,
  previous: SoloistQueueEntry[] | undefined,
  upcoming: SoloistQueueEntry[] | undefined,
): { tracks: SpotifyQueueTrack[]; currentIndex: number } {
  const asTracks = (entries: SoloistQueueEntry[] | undefined): SpotifyQueueTrack[] =>
    (entries ?? [])
      .map((entry) => queueTrackOf(readTrack(entry?.item), entry?.uid))
      .filter((track): track is SpotifyQueueTrack => track !== null);
  const before = asTracks(previous);
  return { tracks: [...before, current, ...asTracks(upcoming)], currentIndex: before.length };
}

/** A queue line, as the rest of this server wants a track described. */
function queueTrackOf(
  track: ReturnType<typeof readTrack>,
  uid?: string,
): SpotifyQueueTrack | null {
  return track.uri
    ? {
      uri: track.uri,
      ...(uid ? { uid } : {}),
      title: track.title,
      artist: track.artist,
      album: track.album,
      coverUrl: track.coverUrl,
      durationSec: track.durationSec,
    }
    : null;
}

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

    // Ask Spotify for lossless before the process starts: the app applies a quality change from
    // the next track, so setting it after would leave the first one at whatever it defaulted to.
    await applyPreferences(zoneId, this.settings.lossless !== false);

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
      currentTrack: null,
      queue: { previous: [], upcoming: [] },
      appPaused: false,
      starting: false,
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
    if (runner.starting) {
      return;
    }
    const track = readTrack(event.item);
    const uri = track.uri;

    // Nothing an inactive device reports is about this room, and everything below would act on it.
    //
    // Connect tells every device the account owns what the account is doing, note for note — same
    // track, same queue, same position. A room that reads that as its own has no way to tell a
    // listener's doing from another room's: two rooms on one account each saw the other's track
    // start, read it as a skip, stepped their own queue and started playing, which made them the
    // active device and set the other one off again. Neither could hold the account long enough to
    // play anything.
    if (!runner.ws.isActive) {
      if (runner.owner === 'connect') {
        this.log.info('spotify moved playback to another device', { zoneId });
        runner.owner = 'queue';
        runner.currentUri = null;
        runner.currentTrack = null;
        this.finishTrack(zoneId);
        this.controller?.stopPlayback(zoneId);
      } else if (runner.wantedUri) {
        // A Spotify account plays on one device at a time, and this room has just lost it. Its
        // audio has already stopped at the source, so saying so beats streaming silence.
        this.log.info('spotify gave the account to another device; this zone stops', { zoneId });
        runner.wantedUri = null;
        runner.appPaused = false;
        this.finishTrack(zoneId);
        this.controller?.transport(zoneId, 'stop');
      }
      return;
    }

    // Both lists arrive together on `queue_changed`, unasked after every change. They are what
    // tells a step backwards from a step forwards, and while the app owns the zone they are also
    // the only account anyone here has of what is coming.
    if (Array.isArray(event.previous) || Array.isArray(event.upcoming)) {
      runner.queue = {
        previous: urisOf(event.previous),
        upcoming: urisOf(event.upcoming),
      };
      if (runner.owner === 'connect') {
        this.publishQueue(zoneId, runner, event);
      }
    }

    if (event.type === 'track_changed' && uri) {
      if (runner.owner === 'queue') {
        const change = classifyTrackChange(uri, runner.wantedUri, runner.queue);
        if (change === 'back') {
          // Someone pressed back on the phone. Soloist has already gone to its own previous track,
          // which is not ours, so this zone's queue is walked back and the track it lands on is
          // played over the top. Deliberately without pausing Soloist first: the pause comes back
          // as an event indistinguishable from someone pausing on the phone, and the moment of the
          // wrong track that pausing would save is shorter than the confusion it causes.
          this.log.info('the spotify app stepped back a track', { zoneId });
          runner.wantedUri = null;
          this.controller?.transport(zoneId, 'previous');
          return;
        }
        if (change === 'forward') {
          // Someone pressed next on the phone. Ending the stream is not enough: a zone finishes a
          // track when its own clock reaches the end, not when the audio stops arriving, so on a
          // skip the room would fall silent and sit there for the rest of the track's length.
          // Walking the queue on is what a skip actually means.
          this.log.info('the spotify app skipped past our track', {
            zoneId,
            expected: runner.wantedUri,
            got: uri,
          });
          runner.wantedUri = null;
          this.controller?.transport(zoneId, 'next');
          return;
        }
      }
      if (runner.owner === 'connect' && uri !== runner.currentUri) {
        // The app moved to its own next track. The stream carries on; only the labels change.
        runner.currentUri = uri;
        runner.currentTrack = queueTrackOf(track);
        this.publishTrack(zoneId, track);
        return;
      }
    }

    // Play and pause pressed on the app, for a zone this server is driving. Only from the room
    // that is sounding: Connect tells every device what the account is doing, so an idle room
    // hears about a pause that was never meant for it.
    if (runner.owner === 'queue' && runner.wantedUri && runner.ws.isActive) {
      if (event.status === 'idle' || event.status === 'stopped') {
        // Autoplay is off, so Soloist stops at the end of a track rather than recommending its way
        // onwards. Ending the stream is what the engine reads as the end, and the queue here picks
        // what follows.
        this.log.debug('soloist reached the end of our track', { zoneId, uri: runner.wantedUri });
        this.finishTrack(zoneId);
        return;
      }
      if (event.status === 'paused' && !runner.appPaused) {
        this.log.info('the spotify app paused this zone', { zoneId });
        runner.appPaused = true;
        this.controller?.transport(zoneId, 'pause');
        return;
      }
      if (event.status === 'playing' && runner.appPaused) {
        this.log.info('the spotify app resumed this zone', { zoneId });
        runner.appPaused = false;
        this.controller?.transport(zoneId, 'resume');
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
    runner.currentTrack = queueTrackOf(track);
    runner.wantedUri = null;
    runner.appPaused = false;
    // A takeover is announced as playback, not as a queue, so the list has to be asked for once.
    // After this it arrives by itself whenever the listener changes anything.
    runner.ws.requestQueue();

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

  /** Hand the app's queue over to the zone, so a room shows the album someone put on. */
  private publishQueue(zoneId: number, runner: ZoneRunner, event: SoloistStateEvent): void {
    const current = runner.currentTrack;
    if (!current) {
      return;
    }
    const { tracks, currentIndex } = buildMirroredQueue(current, event.previous, event.upcoming);
    this.log.debug('mirroring the spotify app queue', {
      zoneId,
      items: tracks.length,
      currentIndex,
    });
    this.controller?.updateQueue(zoneId, tracks, currentIndex);
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
    runner.currentTrack = null;
    runner.appPaused = false;
    // Everything Soloist says between here and the first note of the new track is about what came
    // before it, and reading any of it would be acting on a room that is mid-change.
    runner.starting = true;
    try {
      // Take the account before asking for anything. A `play` from a device that does not hold the
      // session is a request to the account, and Spotify sends it to whichever room does hold it —
      // so starting a track in the kitchen started it in the living room instead.
      if (!runner.ws.isActive) {
        runner.ws.activate();
        if (!(await runner.ws.waitUntilActive())) {
          this.log.warn('soloist could not take the spotify account for this zone', { zoneId });
          return null;
        }
      }
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
    } finally {
      runner.starting = false;
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
    const bitDepth = await this.probeDepth(stream);
    this.log.info('soloist track depth measured', { zoneId, uri, bitDepth: bitDepth ?? 'unknown' });
    return this.pipeSourceFor(zoneId, stream, bitDepth);
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

  /**
   * Read a little audio to measure it, then put it back so nothing is lost from the track.
   *
   * Keeps reading until something is actually audible. The pipe carries silence for a moment
   * after a track is announced, and silence is not evidence — measuring the first frames that
   * happen to arrive would call a 24-bit master 16-bit as often as it got it right.
   */
  private async probeDepth(stream: Readable): Promise<16 | 24 | undefined> {
    const need = DEPTH_PROBE_FRAMES * SOLOIST_SINK_CHANNELS * 3;
    const chunks: Buffer[] = [];
    let total = 0;
    let depth: 16 | 24 | undefined;
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
        if (total < need) {
          return;
        }
        depth = SoloistPlaybackService.measureDepth(Buffer.concat(chunks));
        // Undefined means it was all silence so far; keep listening rather than settle for it.
        if (depth) {
          done();
        }
      };
      const timer = setTimeout(done, DEPTH_PROBE_TIMEOUT_MS);
      stream.on('data', onData);
    });
    if (!total) {
      return undefined;
    }
    stream.unshift(Buffer.concat(chunks));
    return depth;
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
