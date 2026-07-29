import type { AudioType, LineInIconType } from '@/domain/zones/enums';
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
  album: string;
  artist: string;
  /** Where the audio comes from. A real domain concept, not a Loxone artefact. */
  audiopath: string;
  /** Which kind of source is playing. `ApiSourceKind` is the public, readable form. */
  audiotype: AudioType;
  /** Loxone leftover: duplicates `power`. */
  clientState: 'on' | 'off';
  coverurl: string;
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
  name: string;
  /** Loxone leftover: this is the zone id. */
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
  /** Loxone leftover: numeric file/container type for the Loxone app. */
  type: number;
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
