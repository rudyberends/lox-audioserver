export interface AudioSyncEventPlayer {
  id: string;
  playerid: number;
  name: string;
}

export interface AudioSyncGroupPayload {
  group: string;
  mastervolume: number;
  players: AudioSyncEventPlayer[];
  type: 'dynamic';
}

export type GroupSource = 'manual' | 'backend';

/**
 * Single audio group definition tracked in memory.
 */
export interface GroupRecord {
  /** Leader zone ID (controlling player) */
  leader: number;
  /** Members (always includes the leader) */
  members: number[];
  /** Backend identifier (e.g., BeoLink, MusicAssistant) */
  backend: string;
  /** Optional external ID coming from a backend or HTTP request */
  externalId?: string;
  /** Source of the group definition */
  source: GroupSource;
  /** Last modification timestamp */
  updatedAt: number;
}

export type GroupChangeEvent = 'new' | 'update' | 'remove';

export type GroupChangeListener = (
  event: GroupChangeEvent,
  leader: number,
  record?: GroupRecord,
) => void;
