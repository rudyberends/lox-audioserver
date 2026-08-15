import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { PlaybackSource } from '@/application/playback/audioManager';
import { PulseSoundCard } from '@/adapters/inputs/pulse/pulseSoundCard';
import {
  applyPreferences,
  isZonePaired,
  probeBinary,
  soloistDataDir,
  startPersistent,
  type SoloistRunHandle,
} from '@/adapters/inputs/spotify/soloist/soloistProcess';
import { fetchBuild } from '@/adapters/inputs/spotify/soloist/soloistUpdater';
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
 * How often to ask Spotify whether it has published a new build.
 *
 * Daily, because a build lasts 90 days and there is no hurry — and because with an etag the check
 * costs a couple of hundred bytes, so there is nothing to save by doing it less.
 */
const BUILD_CHECK_INTERVAL_MS = 24 * 3600_000;

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
   * Whether the last pause was ours.
   *
   * Soloist reports a pause the same way whoever asked for it, and it reports two of them per
   * pause. Without knowing which are ours, our own stop comes back as "someone paused this zone
   * on their phone" — which is how a zone once paused and resumed itself in the space of a second.
   */
  selfPaused: boolean;
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
  /** The sound card Soloist plays into: no daemon, the audio lands in this process. */
  private readonly audio = new PulseSoundCard('soloist');
  private readonly runners = new Map<number, ZoneRunner>();
  private readonly starting = new Map<number, Promise<ZoneRunner | null>>();
  /** Track lengths as Soloist reported them, so a position update can carry one. */
  private readonly durations = new Map<number, number>();

  private controller: SpotifyConnectController | null = null;
  private buildTimer: NodeJS.Timeout | null = null;

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
    this.watchForBuilds();
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
        await this.audio.remove(zoneId);
      }
    }
    for (const zoneId of wanted) {
      await this.ensureRunner(zoneId).catch(() => null);
    }
  }

  /**
   * Keep the program itself up to date.
   *
   * Soloist expires 90 days after it was built, and until now that meant someone had to notice a
   * dead room, work out why, and go and fetch a new one. Spotify publishes builds as plain files
   * with an etag, so this asks daily and installs what it finds. Switching the backend on with
   * nothing installed fetches one straight away, which is the whole of the setup this step used
   * to be.
   */
  private watchForBuilds(): void {
    if (this.buildTimer) {
      return;
    }
    void this.updateBuild('startup');
    this.buildTimer = setInterval(() => void this.updateBuild('daily'), BUILD_CHECK_INTERVAL_MS);
    // Nothing here should hold the process open.
    this.buildTimer.unref?.();
  }

  private async updateBuild(reason: 'startup' | 'daily'): Promise<void> {
    const installed = await probeBinary();
    const known = installed.present ? this.settings.build : undefined;
    const result = await fetchBuild(known);
    if (result.status === 'unsupported-arch') {
      this.log.info('spotify publishes no soloist for this machine; upload one by hand', {
        arch: result.arch,
      });
      return;
    }
    if (result.status === 'failed') {
      // Never fatal: an installed build keeps playing, and an absent one is already reported by
      // readiness as the thing that is missing.
      this.log.warn('could not fetch a soloist build', { reason, message: result.message });
      await this.recordBuild({});
      return;
    }
    if (result.status === 'unchanged') {
      this.log.debug('soloist build is current', { reason });
      await this.recordBuild({ signature: result.signature });
      return;
    }
    await this.recordBuild({
      signature: result.signature,
      digest: result.digest,
      installedAt: Date.now(),
    });
    await this.adoptNewBuild();
  }

  /**
   * Put a freshly installed build to use.
   *
   * A running process holds its own copy of the program, so replacing the file changes nothing
   * until it restarts — and restarting a room that is playing would cut the music for a program
   * that has 90 days left. So it waits: rooms that are idle pick it up now, the rest at the next
   * check, or whenever they next stop.
   */
  private async adoptNewBuild(): Promise<void> {
    const playing = [...this.runners.values()].some((runner) => runner.stream !== null);
    if (playing) {
      this.log.info('new soloist build installed; rooms will pick it up once they are quiet');
      return;
    }
    const zoneIds = [...this.runners.keys()];
    for (const zoneId of zoneIds) {
      const runner = this.runners.get(zoneId);
      if (!runner) {
        continue;
      }
      runner.ws.close();
      runner.handle.stop();
      this.runners.delete(zoneId);
    }
    for (const zoneId of zoneIds) {
      await this.ensureRunner(zoneId).catch(() => null);
    }
    this.log.info('rooms restarted on the new soloist build', { zones: zoneIds.length });
  }

  private async recordBuild(patch: {
    signature?: string;
    digest?: string;
    installedAt?: number;
  }): Promise<void> {
    try {
      await this.configPort.updateConfig((cfg) => {
        const spotify = cfg.content?.spotify;
        if (!spotify) {
          return;
        }
        const previous = spotify.soloist?.build ?? {};
        spotify.soloist = {
          ...(spotify.soloist ?? {}),
          build: { ...previous, ...patch, checkedAt: Date.now() },
        };
      });
    } catch {
      /* best effort; the figure is a convenience, not state anything depends on */
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
    // The cards go too. They exist for these players and nothing else, and a socket left listening
    // for a backend nobody selected is an open door onto a room with no one behind it.
    await this.audio.stop();
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
    if (!(await this.audio.ensure(zoneId))) {
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
      env: await this.audio.childEnv(zoneId),
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
      selfPaused: false,
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
          // Spotify carries on by itself whatever `player.autoplay` is set to — measured, the
          // preference is written and ignored — so the room's own queue is not the only thing that
          // decides what sounds next. Silencing it here is what keeps a zone that has run out of
          // queue from leaving Spotify playing to nobody, holding the account as it goes. If the
          // queue does have something, the play that follows starts it again.
          runner.selfPaused = true;
          runner.ws.pause();
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
      if (event.status === 'paused' && !runner.appPaused && !runner.selfPaused) {
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
      const opened = this.openAudio(zoneId);
      if (!opened) {
        return;
      }
      runner.stream = opened.stream;
      const source = opened.source;
      this.log.info('the spotify app took this zone over', { zoneId, uri: track.uri });
      this.controller?.startPlayback(zoneId, 'spotify-connect', source, this.metadataFor(track));
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
    // Whatever arrives from here on belongs to the track that is over.
    this.audio.discardPending(zoneId);
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
      runner.selfPaused = false;
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

    // The very first track of a session has to wait for Soloist to say what it plays in; after
    // that the answer is already there.
    await this.audio.waitForSpec(zoneId);
    const opened = this.openAudio(zoneId);
    if (!opened) {
      return null;
    }
    runner.stream = opened.stream;
    return opened.source;
  }

  /**
   * The zone's audio, however playback came about.
   *
   * Whatever Soloist asked to play in, we take: it decodes to float and says so when it opens the
   * stream, and passing that on untouched is one conversion fewer than pinning a format and having
   * something meet it. Not `realTime` — reading this stream is what releases the next grant, so the
   * pacing is already ours and a second timer would only fight it.
   */
  private openAudio(zoneId: number): { stream: Readable; source: PlaybackSource } | null {
    const stream = this.audio.takeStream(zoneId);
    const spec = this.audio.specFor(zoneId);
    if (!stream || !spec) {
      this.log.warn('no audio stream for this zone yet', { zoneId });
      return null;
    }
    return {
      stream,
      source: {
        kind: 'pipe',
        path: `soloist-${zoneId}`,
        format: spec.format as 's16le' | 's24le' | 's32le' | 'f32le',
        sampleRate: spec.rate,
        channels: spec.channels,
        realTime: false,
        stream,
      },
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

  /**
   * Step the Spotify app's own queue, for a zone the app is driving.
   *
   * When the app owns the queue this server cannot walk it: the list belongs to Spotify, and the
   * room is showing a mirror of it. So the zone's own next and previous are passed on to the thing
   * that does own it, which is the only way those buttons can mean anything at all.
   */
  public skip(zoneId: number, direction: 'next' | 'previous'): boolean {
    const runner = this.runners.get(zoneId);
    if (!runner || runner.owner !== 'connect') {
      return false;
    }
    this.log.info('passing a queue step to the spotify app', { zoneId, direction });
    return direction === 'next' ? runner.ws.skipNext() : runner.ws.skipPrevious();
  }

  /**
   * Hold or release the player along with its room.
   *
   * A zone paused in the app used to pause only what this server sends: Soloist played on to the
   * end of the track, and Spotify then moved to the next — so a room resumed a minute later came
   * back somewhere else entirely, if it came back at all.
   *
   * Returns false when this backend is not the one holding that room, so the caller can look
   * elsewhere.
   */
  public setPaused(zoneId: number, paused: boolean): boolean {
    const runner = this.runners.get(zoneId);
    if (!runner || runner.owner !== 'queue' || !runner.wantedUri) {
      return false;
    }
    this.log.debug('holding the player with its zone', { zoneId, paused });
    // Marked as ours, so the pause Soloist reports back is not read as someone reaching for their
    // phone — which would pause the zone a second time, or resume it against the listener.
    runner.selfPaused = paused;
    return paused ? runner.ws.pause() : runner.ws.resume();
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
    if (this.buildTimer) {
      clearInterval(this.buildTimer);
      this.buildTimer = null;
    }
    for (const [zoneId, runner] of [...this.runners]) {
      this.finishTrack(zoneId);
      runner.ws.close();
      runner.handle.stop();
    }
    this.runners.clear();
    await this.audio.stop();
  }

  public dataDirFor(zoneId: number): string {
    return soloistDataDir(zoneId);
  }
}
