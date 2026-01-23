import type { GroupSource } from './groupSource';

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
