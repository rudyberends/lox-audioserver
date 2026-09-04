import { createLogger } from '@/shared/logging/logger';
import { bestEffort } from '@/shared/bestEffort';
import type { GlobalSpotifyConfig, ZoneConfig } from '@/domain/config/types';
import type { PlaybackSource } from '@/application/playback/audioManager';
import type { SpotifyConnectController } from '@/ports/InputsPort';
import type { ConfigPort } from '@/ports/ConfigPort';
import { SoloistPlaybackService } from '@/adapters/inputs/spotify/soloist/soloistPlaybackService';
import { isBrowserZoneId } from '@/application/zones/browserZoneRegistry';

/**
 * Spotify playback for every zone, through the user's own Soloist build.
 *
 * The only client left. librespot was the other one, and it went: Spotify stopped issuing audio
 * keys to accounts made after Nov 2025, so for a growing share of users it could no longer play at
 * all — and everything it did besides playing (minting pathfinder tokens for the personalised
 * browse hub) had already been switched off because that call took the process down with it.
 *
 * This is a thin layer on purpose. {@link SoloistPlaybackService} owns both halves of what Soloist
 * does — a room as a Connect device, and a `--single-track` run per track from an account's own
 * store — and everything upstream of here (queue, metadata, session tracking) never knew which
 * client produced the audio in the first place.
 */
export class SpotifyInputService {
  private readonly log = createLogger('Audio', 'SpotifyService');
  private controller: SpotifyConnectController | null = null;
  /**
   * The backend itself, reachable for the few callers that need more than playback: the admin
   * screens that pair an account, and the Connect controller wiring.
   */
  public readonly soloist: SoloistPlaybackService;

  constructor(private readonly configPort: ConfigPort) {
    this.soloist = new SoloistPlaybackService(configPort);
  }

  /** Stop whatever Spotify is doing in this room, whichever half of Soloist was doing it. */
  public stopActiveSession(zoneId: number, reason?: string): void {
    void this.soloist.stopZone(zoneId, reason ?? 'stop');
  }

  /**
   * A transport command for a zone whose queue belongs to the Spotify app.
   *
   * Returns false when this backend is not the one to ask, so the caller can try elsewhere. Pause
   * and resume reach a run of our own; next and previous only mean something while the app owns the
   * room's queue, because a queue of ours is walked by the room itself.
   */
  public playerCommand(zoneId: number, command: string): boolean {
    const normalized = command.trim().toLowerCase();
    if (normalized === 'pause' || normalized === 'resume') {
      return this.soloist.setPaused(zoneId, normalized === 'pause');
    }
    if (normalized !== 'next' && normalized !== 'previous') {
      return false;
    }
    return this.soloist.skip(zoneId, normalized);
  }

  /**
   * Put a zone's level on the Spotify app's slider.
   *
   * Only for a room the app is driving, where somebody is looking at that slider. A run of our own
   * is never told: it plays at full scale so the samples reach the sound card untouched, and the
   * room's own output is where its volume belongs.
   */
  public setDeviceVolume(zoneId: number, volumePercent: number): void {
    if (!this.soloist.isEnabled()) {
      return;
    }
    this.soloist.setVolume(zoneId, volumePercent);
  }

  /** The accounts that can play through Soloist, and which of them have been signed in. */
  public async soloistAccounts(): Promise<Array<{ id: string; label: string; paired: boolean }>> {
    return this.soloist.pairedAccounts();
  }

  public configure(controller: SpotifyConnectController): void {
    this.controller = controller;
    // The way back into a zone for playback this server did not start: every room is a Connect
    // device for as long as its process runs, so someone can take it over from a phone at any
    // moment and the zone has to hear about it.
    this.soloist.setController(controller);
  }

  /**
   * Give every zone a Soloist, so each one is a Spotify Connect device.
   *
   * Every zone, whatever the per-zone Connect switch says. That switch means "show this zone as a
   * Spotify Connect target", and Soloist cannot separate the two: there is no option not to
   * advertise, and `deactivate` only gives up being the *active* device. Honouring the switch would
   * mean a zone with Connect turned off could not play Spotify at all, so it is shown as fixed on
   * while this backend is in use.
   */
  public syncZones(zones: ZoneConfig[], _spotifyConfig?: GlobalSpotifyConfig | null): void {
    this.configPort.ensureInputs();
    if (!this.controller) {
      this.log.debug('spotify controller not configured; skipping sync');
      return;
    }
    if (!this.soloist.isEnabled()) {
      void this.soloist.stopAllZones();
      return;
    }
    // Browser tabs excluded: a Soloist makes its zone a device in the account's Spotify app, and a
    // page someone happens to have open has no business appearing there — it would come and go
    // with the tab, under a name nobody chose.
    void this.soloist.syncZones(
      zones.map((zone) => zone.id).filter((zoneId) => !isBrowserZoneId(zoneId)),
    );
  }

  public async shutdown(): Promise<void> {
    // Child processes and a sound server outlive us if nobody says otherwise.
    await bestEffort(() => this.soloist.shutdown(), {
      fallback: undefined,
      onError: 'debug',
      log: this.log,
      label: 'soloist shutdown failed',
    });
  }

  /**
   * Follow a renamed zone into the Spotify app.
   *
   * The name a room advertises under is fixed when its process starts, so the only way to change it
   * is to start again — which is why this is not simply a setter.
   */
  public async renameZone(zoneId: number, name: string): Promise<void> {
    await this.soloist.renameZone(zoneId, name);
  }

  /**
   * The live source for a room the Spotify app is driving.
   *
   * Nothing to hand back: a takeover from the app is announced rather than polled — the backend
   * opens the room's audio and starts playback through the controller the moment it happens.
   */
  public getPlaybackSource(_zoneId: number): PlaybackSource | null {
    return null;
  }

  /**
   * Play one track in a room, from the account it was browsed from.
   *
   * The account travels with the track: on Soloist it decides which store the engine run is
   * started from, which is the whole of playing from a second account.
   */
  public async getPlaybackSourceForUri(
    zoneId: number,
    spotifyUri: string,
    seekPositionMs = 0,
    accountId?: string,
  ): Promise<PlaybackSource | null> {
    return this.soloist.getPlaybackSource(zoneId, spotifyUri, seekPositionMs, accountId);
  }

  /**
   * Warm the next track ahead of time, which Soloist cannot do.
   *
   * An account plays in one place at a time and one engine run holds its store, so there is no
   * second run to warm the next track in: it starts when the track before it has ended.
   */
  public async prefetchPlaybackSourceForUri(): Promise<void> {
    return undefined;
  }
}
