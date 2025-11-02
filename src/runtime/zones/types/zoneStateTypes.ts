import { AudioType, AudioPlaybackMode, RepeatMode, AudioPowerState, FileType, AudioEventType, LineInIconType } from '@/core/loxone/types';


/**
 * -----------------------------------------------------------------------------
 * ZoneState
 * -----------------------------------------------------------------------------
 * Canonical in-memory representation of a zone/player state.
 * Mirrors the official Loxone AudioServer `audio_event` schema.
 *
 * Fields are sorted by required (top) vs optional (bottom).
 * -----------------------------------------------------------------------------
 */
export interface ZoneState {
  /* -------------------------------------------------------------------------
   * REQUIRED FIELDS — must always be present in payloads
   * ----------------------------------------------------------------------- */
  playerid: number;
  name: string;
  album: string;
  artist: string;
  title: string;
  coverurl: string;
  audiopath: string;
  audiotype: AudioType | number;
  mode: AudioPlaybackMode;
  plrepeat: RepeatMode | number;
  plshuffle: number;
  power: AudioPowerState;
  time: number;
  type: FileType | number;
  volume: number;
  qindex: number;

  /* -------------------------------------------------------------------------
   * OPTIONAL FIELDS — may be omitted or null in payloads
   * ----------------------------------------------------------------------- */
  duration?: number;
  duration_ms?: number;
  position_ms?: number;
  eventype?: AudioEventType;
  icontype?: LineInIconType;
  parent?: { id: string; name: string } | null;
  qid?: string;
  sourceName?: string;
  station?: string;
  clientState?: 'on' | 'off';
  qname?: string;
  updatedAt?: number;

  /** Adapter-specific metadata (internal use only, excluded from Loxone payloads) */
  adapterProps?: Record<string, unknown>;

  /** Last played favorite ID (for roomfav/plus sequencing). */
  lastFavoriteId?: number;

  /** Optional playback queue (used internally, not broadcast to Loxone). */
  queue?: {
    id: number;
    items: Array<{
      album: string;
      artist: string;
      audiopath: string;
      audiotype: number;
      coverurl: string;
      duration: number;
      qindex: number;
      station: string;
      title: string;
      unique_id: string;
      user: string;
    }>;
    shuffle: boolean;
    start: number;
    totalitems: number;
  };
}

/**
 * Partial update to ZoneState, used for incremental updates.
 */
export interface ZoneStatePatch {
  [key: string]: any;
}

/**
 * Creates a default, valid ZoneState containing all required fields.
 * Every mandatory field from the client schema is filled with a safe default.
 */
export function createDefaultZoneState(id: number): ZoneState {
  return {
    // REQUIRED
    playerid: id,
    name: '',
    album: '',
    artist: '',
    title: '',
    coverurl: '',
    audiopath: '/dummy/path',
    audiotype: AudioType.File,
    mode: AudioPlaybackMode.Stop,
    plrepeat: RepeatMode.NoRepeat,
    plshuffle: 0,
    power: AudioPowerState.Off,
    time: 0,
    type: FileType.Unknown,
    volume: 0,
    qindex: 0,

    // OPTIONAL (safe defaults)
    duration: 0,
    duration_ms: 0,
    position_ms: 0,
    //eventype: AudioEventType.Unknown,
    //icontype: LineInIconType.LineIn,
    parent: null,
    qid: '',
    sourceName: '',
    station: '',
    //players: [],
    clientState: 'on',
    qname: '',
  };
}


/**
 * Safely get a typed adapter property.
 */
export function getAdapterProp<T = unknown>(
  zone: ZoneState | undefined,
  key: string,
): T | undefined {
  return zone?.adapterProps?.[key] as T | undefined;
}

/**
 * Safely set (or update) an adapter property on a zone state.
 */
export function setAdapterProp<T = unknown>(
  zone: ZoneState,
  key: string,
  value: T,
): void {
  if (!zone.adapterProps) {
    zone.adapterProps = {};
  }
  zone.adapterProps[key] = value;
}

/**
 * Convenience helper to merge multiple adapterProps in one call.
 *
 * Example:
 * ```ts
 * mergeAdapterProps(zone, {
 *   deviceJid: 'abc@products.bang-olufsen.com',
 *   currentSourceId: 'spotify:xyz',
 * });
 * ```
 */
export function mergeAdapterProps(
  zone: ZoneState,
  props: Record<string, unknown>,
): ZoneState {
  zone.adapterProps = {
    ...(zone.adapterProps ?? {}),
    ...props,
  };
  return zone;
}