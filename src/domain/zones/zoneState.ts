import type { AudioEventType, AudioType, FileType, LineInIconType } from '@/domain/zones/enums';
import type { EqualizerBands } from '@/domain/zones/equalizer';

/**
 * The server's internal zone state — the single source of truth every consumer
 * projects from: the public API (`ApiZoneState`), the Loxone clients, DLNA,
 * sendspin and the outputs.
 *
 * It is *not* a Loxone type, despite still carrying some of Loxone's vocabulary.
 * Those leftovers are called out per field below and are being replaced one at a
 * time; the neutral projection in `src/adapters/http/api/zoneProjection.ts` is
 * the seam that lets that happen without moving the public contract. Do not add
 * fields here that only one consumer understands.
 */
export interface ZoneState {
  /** The zone's id, matching its configuration. */
  id: number;
  name: string;

  album: string;
  artist: string;
  /** Where the audio comes from. A real domain concept, not a Loxone artefact. */
  audiopath: string;
  /** Which kind of source is playing. `ApiSourceKind` is the public, readable form. */
  audiotype: AudioType;
  /**
   * Whether the player backing this zone is reachable — distinct from `power`,
   * which follows playback. A Music Assistant player that goes unavailable reports
   * `off` here while `power` still reflects what the zone was doing.
   *
   * Real state, not a Loxone artefact, though the two-value shape is a lossy
   * simplification of the client's own enum (NOT_REACHABLE / OFFLINE /
   * INITIALIZING / ONLINE) — worth widening if a caller ever needs the difference.
   */
  clientState: 'on' | 'off';
  coverurl: string;
  /** Optional motion artwork for clients that support it; legacy outputs ignore it. */
  animatedCoverUrl?: string;
  /** Palette derived from the current cover artwork, when available. */
  artworkColors?: ZoneArtworkColors | null;
  duration: number;
  /** 10-band equalizer, in dB. The Loxone payload serialises this to a string. */
  eq: EqualizerBands;
  /**
   * Which icon represents the current source, from the line-in input's configured
   * `iconType` (see `LineInIconType`). Cleared once real cover art arrives, so a
   * generic turntable glyph gives way to the album picture. Real state, not a
   * Loxone artefact — the numbering is Loxone's, like the other enums here.
   */
  icontype?: LineInIconType;
  mode: 'play' | 'pause' | 'stop';
  plrepeat: number;
  plshuffle: number;
  power: 'on' | 'off';
  qindex: number;
  queueAuthority?: string;
  sourceName: string;
  station: string;
  time: number;
  title: string;
  /**
   * Silenced while keeping the level it will come back to. A muted zone reports
   * `volume: 0` like any other silent zone — mute is the *reason*, which is what a
   * client needs to know whether to draw a crossed-out speaker and what pressing it
   * again should restore. The level to restore is runtime bookkeeping and lives on
   * the zone context, not here.
   *
   * The pair `muted: true` with a volume above zero is nonsense, and
   * `applyZonePatch` is what guarantees it cannot happen.
   */
  muted: boolean;
  qid?: string;
  /**
   * What the zone is playing, as a category the client renders differently:
   * normally a `FileType` (a single file vs a queue/playlist — line-in flips to
   * `File` once real metadata arrives so it stops looking like a container), but
   * while an alert plays it carries an `AudioEventType` instead (bell, alarm, TTS).
   *
   * The two enums share this one field because the Loxone clients read it that
   * way; their numbering does not overlap. Real state, not an artefact — but the
   * overload is worth splitting if anything other than the wire ever reads it.
   */
  type: FileType | AudioEventType;
  volume: number;
  /**
   * Player IDs of all members in this zone's sync group (leader first).
   * Empty when the zone is not grouped. Enriched at emit time from the
   * shared group tracker — not stored authoritatively per zone.
   */
  syncedzones?: number[];
  /**
   * The zone's output protocol (e.g. 'sendspin', 'snapcast', 'googlecast',
   * 'dlna', 'sonos', 'airplay', 'squeezelite'). A custom field the native Loxone
   * client ignores; our own player surfaces it as a grouping hint, since grouping
   * requires matching output protocols (which the native app has no concept of).
   */
  outputProtocol?: string;
  /**
   * Whether this zone's server allows grouping across different output protocols
   * (the `mixedGroupEnabled` config). Custom field; our player uses it to relax
   * the protocol-match grouping hint when mixed groups are enabled.
   */
  mixedGroupEnabled?: boolean;
}

export type ZoneArtworkColors = {
  primary: [number, number, number];
  accent: [number, number, number];
  background_dark: [number, number, number];
  background_light: [number, number, number];
  on_dark: [number, number, number];
  on_light: [number, number, number];
};
