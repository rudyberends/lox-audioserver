import { createLogger } from '@/shared/logging/logger';
import { AudioType, FileType } from '@/domain/zones/enums';
import { resolveLineInSampleRate } from '@/domain/config/lineIn';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { LineInSourcePort } from '@/ports/LineInSourcePort';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { LineInInputConfig } from '@/domain/config/types';
import type { ZoneState } from '@/domain/zones/zoneState';

export type ResolvedLineInInput = {
  id: string;
  name: string;
  iconType: number;
  index: number;
};

const LINEIN_ID_START = 1000001;
const DEFAULT_ICON_TYPE = 0;
const PCM_CHANNELS = 2;
const NO_SIGNAL_TITLE = 'No Signal detected';

/**
 * Makes a line-in the active source on a zone.
 *
 * This used to live inside the Loxone command handlers, which meant only a Loxone
 * command could select a line-in — and that the zone→input bookkeeping lived in a
 * closure rebuilt on every Loxone reconnect, orphaning its ingest listeners. Both
 * are fixed by owning that state here, in one long-lived instance that any adapter
 * can drive.
 *
 * What stays with the caller is protocol: parsing ids out of a command string, and
 * deciding what to name an input the caller already resolved.
 */
export class LineInActivationService {
  private readonly log = createLogger('Audio', 'LineInActivation');
  private readonly configPort: ConfigPort;
  private readonly source: LineInSourcePort;
  private readonly activeLineInByZone = new Map<number, { inputId: string; stop: () => void }>();
  private readonly lineInWatchByZone = new Map<number, { inputId: string; stop: () => void }>();
  private zoneManager: ZoneManagerFacade | null = null;

  constructor(configPort: ConfigPort, source: LineInSourcePort) {
    this.configPort = configPort;
    this.source = source;
  }

  public initOnce(deps: { zoneManager: ZoneManagerFacade }): void {
    if (this.zoneManager) {
      throw new Error('line-in activation service already initialized');
    }
    if (!deps.zoneManager) {
      throw new Error('line-in activation service missing zone manager');
    }
    this.zoneManager = deps.zoneManager;
  }

  private get zones(): ZoneManagerFacade {
    if (!this.zoneManager) {
      throw new Error('zone manager not configured');
    }
    return this.zoneManager;
  }

  /** Every configured line-in, in config order, with its resolved id/name/icon. */
  public listLineInInputs(): ResolvedLineInInput[] {
    const config = this.configPort.getConfig();
    const entries = Array.isArray(config.inputs?.lineIn?.inputs) ? config.inputs!.lineIn!.inputs! : [];
    const macId = this.resolveMacId();

    return entries.map((entry, index) => {
      const record = entry && typeof entry === 'object' ? (entry as LineInInputConfig) : {};
      const id = typeof record.id === 'string' && record.id.trim()
        ? record.id.trim()
        : `${macId}#${LINEIN_ID_START + index}`;
      const name = typeof record.name === 'string' && record.name.trim()
        ? record.name.trim()
        : `LineIn${index + 1}`;
      const iconType = Number.isFinite(record.iconType) ? Number(record.iconType) : DEFAULT_ICON_TYPE;
      return { id, name, iconType, index };
    });
  }

  /**
   * Hand a command to whatever serves this input. The bridge passes it to its
   * on_command hook, which is where the knowledge of the attached hardware lives —
   * so adding a verb is a change to that script, not to this server.
   */
  public sendCommand(inputId: string, command: string, args: string[] = []): void {
    this.log.info('line-in command', { inputId, command, args });
    this.source.sendCommand(inputId, command, args);
  }

  public findLineInInput(inputId: string): ResolvedLineInInput | null {
    if (!inputId) {
      return null;
    }
    return this.listLineInInputs().find((entry) => entry.id === inputId) ?? null;
  }

  public findLineInIndexById(inputId: string): number | null {
    const match = this.findLineInInput(inputId);
    return match ? match.index : null;
  }

  /**
   * Make `inputId` the active source on `zoneId`.
   *
   * Synchronous on purpose: the Loxone command path answers immediately after this
   * returns, and awaiting anything here would reorder the response against the
   * state patch.
   *
   * `meta` lets a caller that already resolved the input pass its own name and icon.
   * Without it the service looks them up, falling back to the no-signal title —
   * which is the right answer for an unknown id from an HTTP caller, but not for
   * the Loxone client, which has its own fallbacks.
   */
  public activateLineIn(
    zoneId: number,
    inputId: string,
    meta?: { title: string; iconType: number },
  ): void {
    this.log.info('line-in selected', { zoneId, inputId });
    // Selecting the input is what makes the source wanted. A sendspin source is told
    // directly (via requestStart below); a polling bridge reads this on its next
    // status post and runs its on_start hook, which is what switches on gear that
    // does not power up by itself.
    this.source.markWanted(inputId);
    this.startControllableSource(inputId);
    this.ensureLineInWatch(zoneId, inputId);
    const resolved = meta ?? this.resolveLineInMeta(inputId);
    this.startLineInPlayback(zoneId, inputId, resolved.title, resolved.iconType);
  }

  /**
   * Release an input because the zone is done with it: tell a controllable device
   * to stop, drop the stream, and withdraw the want.
   *
   * This is the whole teardown in one place, so a caller that only has an input id
   * — a zone switching to Spotify, say — does not have to know which of those three
   * steps apply to this particular source.
   */
  public releaseLineIn(inputId: string): void {
    this.source.requestStop(inputId);
    // Withdraw the want BEFORE queueing the stop: clearing it also drops any
    // pending commands for this input (deliberately — a command meant for a source
    // we have left must not fire later). Queue the stop after, or it is the very
    // thing that gets thrown away.
    this.source.clearWanted(inputId);
    this.stopControllableSource(inputId);
  }

  /** Whether this input accepts commands at all. A jack or turntable does not. */
  public isControllable(inputId: string): boolean {
    return this.resolveLineInInputConfig(inputId)?.controllable === true;
  }

  /**
   * Send a command, but only to a source that can act on one.
   *
   * The guard is the point of the whole flag: for an uncontrollable input there is
   * nothing on the other end, so a queued command would sit there until some later
   * selection drained it and drove hardware nobody asked for.
   */
  public sendCommandIfControllable(inputId: string, command: string, args: string[] = []): boolean {
    if (!this.isControllable(inputId)) {
      return false;
    }
    this.sendCommand(inputId, command, args);
    return true;
  }

  /**
   * Tell the device to start.
   *
   * `source_active` alone is enough for gear whose on_start hook powers it up and it
   * begins playing by itself. A deck like a BeoSound 9000 does not: selecting it has
   * to reach the device as an actual command, or the source is chosen, silent, and
   * looks broken. Sent on selection rather than on first audio, because waiting for
   * audio is exactly the deadlock — nothing arrives until the device is told to go.
   */
  private startControllableSource(inputId: string): void {
    this.sendCommandIfControllable(inputId, 'start');
  }

  /**
   * Tell the device to stop, when the zone moves away from it.
   *
   * Without this a CD keeps spinning into a room now playing something else — the
   * transport was started by us, so releasing it is ours too.
   */
  private stopControllableSource(inputId: string): void {
    this.sendCommandIfControllable(inputId, 'stop');
  }

  private startLineInPlayback(
    zoneId: number,
    inputId: string,
    title: string,
    iconType: number,
  ): void {
    this.clearActiveLineIn(zoneId);
    this.source.requestStart(inputId);
    const session = this.source.getSession(inputId);
    const stream = session?.stream ?? null;
    if (!stream) {
      this.log.info('line-in ingest pending; waiting for stream', { zoneId, inputId });
      this.overwriteLineInState(zoneId, inputId, NO_SIGNAL_TITLE, iconType, 'pause');
      return;
    }

    const inputConfig = this.resolveLineInInputConfig(inputId);
    const sessionFormat = session?.format ?? null;
    const sampleRate = sessionFormat?.sampleRate ?? resolveLineInSampleRate(inputConfig);
    const channels = sessionFormat?.channels ?? PCM_CHANNELS;
    const pcmFormat = sessionFormat?.pcmFormat ?? 's16le';

    this.overwriteLineInState(zoneId, inputId, title, iconType, 'play');
    const stop = this.source.onStop(inputId, () => {
      const active = this.activeLineInByZone.get(zoneId);
      if (!active || active.inputId !== inputId) {
        return;
      }
      this.handleLineInStopped(zoneId, inputId);
    });
    this.activeLineInByZone.set(zoneId, { inputId, stop });
    this.zones.inputs.playInputSource(
      zoneId,
      'linein',
      {
        kind: 'pipe',
        path: `linein:${inputId}`,
        format: pcmFormat,
        sampleRate,
        channels,
        realTime: true,
        stream,
      },
      {
        title,
        artist: '',
        album: '',
        // Deliberately the `//` form: it is what a started line-in leaves in the
        // zone state, and downstream audiotype checks key on exactly that.
        audiopath: `linein://${inputId}`,
        station: '',
        duration: 0,
      },
    );
  }

  private clearActiveLineIn(zoneId: number): void {
    const active = this.activeLineInByZone.get(zoneId);
    if (active) {
      // Stop only. The want must survive, because the zone is about to be handed
      // the same or another line-in.
      this.source.requestStop(active.inputId);
      active.stop();
      this.activeLineInByZone.delete(zoneId);
    }
  }

  private handleLineInStopped(zoneId: number, inputId: string): void {
    const zoneState = this.zones.getZoneState(zoneId);
    if (!zoneState) {
      return;
    }
    const currentPath = zoneState.audiopath ?? '';
    const matches = currentPath === `linein:${inputId}` || currentPath === `linein://${inputId}`;
    if (!matches) {
      return;
    }
    this.zones.applyPatch(
      zoneId,
      {
        mode: 'pause',
        time: 0,
        duration: 0,
        title: NO_SIGNAL_TITLE,
        artist: '',
        album: '',
        station: '',
        audiopath: `linein:${inputId}`,
        ...this.resolveLineInTypes(inputId),
      },
      true,
    );
    this.clearActiveLineIn(zoneId);
  }

  private resolveLineInMeta(inputId: string): { title: string; iconType: number } {
    const match = this.findLineInInput(inputId);
    return {
      title: match?.name ?? NO_SIGNAL_TITLE,
      iconType: match?.iconType ?? DEFAULT_ICON_TYPE,
    };
  }

  private resolveLineInInputConfig(inputId: string): LineInInputConfig | null {
    const index = this.findLineInIndexById(inputId);
    if (index === null || index < 0) {
      return null;
    }
    const config = this.configPort.getConfig();
    const entries = Array.isArray(config.inputs?.lineIn?.inputs)
      ? config.inputs!.lineIn!.inputs!
      : [];
    return (entries[index] ?? null) as LineInInputConfig | null;
  }

  /** A source that advertises transport controls presents as a file, not a jack. */
  private resolveLineInTypes(inputId: string): { audiotype: number; type: number } {
    const controls = this.source.getControlSupport(inputId);
    if (controls && controls.length) {
      return { audiotype: AudioType.File, type: FileType.File };
    }
    return { audiotype: AudioType.LineIn, type: FileType.LineIn };
  }

  /**
   * Arm a start-watch for the zone, so a source that appears later (a bridge that
   * reconnects, hardware that took a moment) still starts playing.
   *
   * The watch is sticky: it survives playback starting, and is torn down only when
   * the zone is pointed at a different input. Its own guard — the zone must still
   * be on this audiopath — is what keeps it from resurrecting a zone that has since
   * moved on to something else.
   */
  private ensureLineInWatch(zoneId: number, inputId: string): void {
    const existing = this.lineInWatchByZone.get(zoneId);
    if (existing) {
      if (existing.inputId === inputId) {
        return;
      }
      // The zone is pointing elsewhere for good, so this is where a controllable
      // device gets told to stop — not in clearActiveLineIn, which also runs when
      // the same input is merely being restarted.
      this.source.requestStop(existing.inputId);
      // Order matters: clearWanted drops queued commands for this input, so the
      // stop has to be queued after it rather than before.
      this.source.clearWanted(existing.inputId);
      this.stopControllableSource(existing.inputId);
      existing.stop();
      this.lineInWatchByZone.delete(zoneId);
    }
    const stop = this.source.onStart(inputId, () => {
      const zoneState = this.zones.getZoneState(zoneId);
      if (!zoneState) {
        return;
      }
      const currentPath = zoneState.audiopath ?? '';
      const matches = currentPath === `linein:${inputId}` || currentPath === `linein://${inputId}`;
      if (!matches) {
        return;
      }
      const { title, iconType } = this.resolveLineInMeta(inputId);
      this.startLineInPlayback(zoneId, inputId, title, iconType);
    });
    this.lineInWatchByZone.set(zoneId, { inputId, stop });
  }

  private overwriteLineInState(
    zoneId: number,
    inputId: string,
    title: string,
    iconType: number,
    mode: ZoneState['mode'],
  ): void {
    const current = this.zones.getZoneState(zoneId);
    if (!current) {
      return;
    }
    const { audiotype, type } = this.resolveLineInTypes(inputId);
    const sourceName = this.resolveZoneSourceName(zoneId) ?? current.sourceName;
    const patch: Partial<ZoneState> = {
      playerid: current.playerid,
      name: current.name,
      volume: current.volume,
      plrepeat: 0,
      plshuffle: 0,
      qindex: 0,
      qid: '',
      time: 0,
      duration: 0,
      audiopath: `linein:${inputId}`,
      audiotype,
      icontype: iconType,
      type,
      title,
      artist: '',
      album: '',
      coverurl: '',
      station: '',
      mode,
      clientState: 'on',
      power: 'on',
      queueAuthority: 'local',
      sourceName,
    };
    this.zones.applyPatch(zoneId, patch, true);
  }

  private resolveZoneSourceName(zoneId: number): string | undefined {
    const config = this.configPort.getConfig();
    const zone = config.zones?.find((entry) => entry.id === zoneId);
    const mac = zone?.sourceMac?.trim();
    if (mac) {
      return mac;
    }
    const systemMac = config.system?.audioserver?.macId?.trim();
    return systemMac || undefined;
  }

  private resolveMacId(): string {
    const macId = this.configPort.getConfig()?.system?.audioserver?.macId?.trim().toUpperCase();
    return macId || 'UNKNOWN';
  }
}

export type LineInActivationServiceDeps = {
  configPort: ConfigPort;
  source: LineInSourcePort;
};

export function createLineInActivationService(
  deps: LineInActivationServiceDeps,
): LineInActivationService {
  return new LineInActivationService(deps.configPort, deps.source);
}
