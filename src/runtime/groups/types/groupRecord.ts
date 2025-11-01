import { GroupSource } from './groupSource';

/**
 * A single audio group record, representing a logical cluster of zones.
 */
export interface GroupRecord {
  /** Leader zone ID (the controlling player) */
  leader: number;
  /** Member zone IDs, always includes the leader */
  members: number[];
  /** Backend identifier (e.g., BeoLink, MusicAssistant) */
  backend: string;
  /** Optional external ID (for HTTP or backend-originated groups) */
  externalId?: string;
  /** Source of the group definition */
  source: GroupSource;
  /** Last modification timestamp (ms since epoch) */
  updatedAt: number;
}