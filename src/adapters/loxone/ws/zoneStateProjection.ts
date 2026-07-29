/**
 * Projects the server's `ZoneState` onto the payload Loxone clients expect.
 *
 * This is the counterpart of `src/adapters/http/api/zoneProjection.ts`: both take
 * the same internal state and shape it for one consumer. Keeping the Loxone wire
 * format in its own type here — rather than letting `ZoneState` be that format —
 * is what makes Loxone a projection instead of the source of truth. Every field
 * below that only the Loxone clients understand should ultimately be *computed*
 * here rather than carried in `ZoneState`; `mastervolume` already is.
 */
import type { AudioEventType, AudioType, FileType, LineInIconType } from '@/domain/zones/enums';
import { parseServiceNativeAudiopath } from '@/domain/loxone/audiopath';
import type { ZoneState } from '@/domain/zones/zoneState';
import { formatEqualizerSettings } from '@/domain/zones/equalizer';

/**
 * The `audio_event` entry as the Loxone Miniserver and native app parse it.
 *
 * Field names and numeric encodings are Loxone's and cannot change: they mirror
 * the official Audio Server UI. Anything here that is *not* in the native
 * protocol is marked as ours.
 */
/**
 * Browse context for the item that started playback. The native client accepts it
 * but does not require it, and the server has never populated it — it is emitted as
 * null. Kept in the payload type because dropping the key entirely is a wire change.
 */
export interface LoxoneParentMeta {
  audiopath: string;
  coverurl: string;
  id: string;
  items: number;
  name: string;
  type: number;
}

export interface LoxoneZoneState {
  album: string;
  artist: string;
  audiopath: string;
  audiotype: AudioType;
  clientState: 'on' | 'off';
  coverurl: string;
  duration: number;
  /** Comma-separated 10-band EQ values for the Loxone app's AudioZone control. */
  equalizerSettings: string;
  icontype?: LineInIconType;
  mode: 'play' | 'pause' | 'stop';
  name: string;
  parent: LoxoneParentMeta | null;
  playerid: number;
  plrepeat: number;
  plshuffle: number;
  power: 'on' | 'off';
  qindex: number;
  queueAuthority?: string;
  sourceName: string;
  station: string;
  time: number;
  title: string;
  qid?: string;
  /** A `FileType`, or an `AudioEventType` while an alert plays. */
  type: FileType | AudioEventType;
  volume: number;
  /** Player ids of every member of this zone's sync group, leader first. */
  syncedzones: number[];
  /** The sync group leader's volume; 0 when the zone is not grouped. */
  mastervolume: number;
  /**
   * Ours, not Loxone's: the zone's output protocol. The native client ignores it;
   * our own player uses it as a grouping hint, since grouping requires matching
   * output protocols — a concept the native app has no notion of.
   */
  outputProtocol?: string;
  /** Ours, not Loxone's: whether this server allows mixed-protocol grouping. */
  mixedGroupEnabled?: boolean;
}

export type ZoneStateProjectionContext = {
  /** Sync group this zone belongs to, if any. */
  group: { leader: number; members: number[] } | null;
  /** Volume of the group leader, used for `mastervolume`. */
  leaderVolume: number;
  outputProtocol?: string;
  mixedGroupEnabled?: boolean;
  /**
   * Rewrites a service-native audiopath into the disguise the native client
   * expects (`spotify@bridge-…`). Identity when there is nothing to translate.
   */
  audiopathToLoxone: (audiopath: string) => string;
};

function clamp01to100(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** True for a raw source id in any of the forms that can reach these fields. */
function looksLikeAudiopath(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.startsWith('spotify:') ||
    lower.startsWith('spotify@') ||
    Boolean(parseServiceNativeAudiopath(value))
  );
}

/**
 * Guard the emitted title: an audiopath is never a valid title. A background
 * queue-fill race can momentarily leave a service-native audiopath (or a
 * `spotify:`/`spotify@` id) in state.title; replace it with the zone name so the
 * raw id never reaches the client.
 */
function titleOrFallback(title: string | undefined, zoneName: string): string {
  const raw = (title ?? '').trim();
  if (!raw) {
    return raw;
  }
  return looksLikeAudiopath(raw) ? zoneName : (title ?? '');
}

/**
 * The station line is a human-readable source label (radio name, playlist name).
 * A raw audiopath must never surface there. Pre-service-native this was blanked
 * implicitly — the old `spotify@bridge` form matched the client's own sanitising;
 * the service-native form does not, so blank it here.
 */
function blankAudiopathStation(station: string | undefined): string {
  const raw = (station ?? '').trim();
  if (!raw) {
    return '';
  }
  return looksLikeAudiopath(raw) ? '' : (station ?? '');
}

export function toLoxoneZoneState(
  state: ZoneState,
  ctx: ZoneStateProjectionContext,
): LoxoneZoneState {
  const syncedzones = ctx.group
    ? Array.from(new Set<number>([ctx.group.leader, ...ctx.group.members]))
    : [];

  return {
    album: state.album,
    artist: state.artist,
    audiopath: ctx.audiopathToLoxone(state.audiopath),
    audiotype: state.audiotype,
    clientState: state.clientState,
    coverurl: state.coverurl,
    duration: state.duration,
    equalizerSettings: formatEqualizerSettings(state.eq),
    icontype: state.icontype,
    mode: state.mode,
    name: state.name,
    // Never populated by the server; the client treats null as "no browse context".
    parent: null,
    playerid: state.playerid,
    plrepeat: state.plrepeat,
    plshuffle: state.plshuffle,
    power: state.power,
    qindex: state.qindex,
    queueAuthority: state.queueAuthority,
    sourceName: state.sourceName,
    station: blankAudiopathStation(state.station),
    time: state.time,
    title: titleOrFallback(state.title, state.name),
    qid: state.qid,
    type: state.type,
    volume: state.volume,
    syncedzones,
    // Computed here rather than carried in ZoneState: it is a view of the group's
    // leader, which only this payload needs.
    mastervolume: ctx.group ? clamp01to100(ctx.leaderVolume) : 0,
    outputProtocol: ctx.outputProtocol,
    mixedGroupEnabled: ctx.mixedGroupEnabled,
  };
}
