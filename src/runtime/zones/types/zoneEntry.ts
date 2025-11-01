import type { ZoneDefinition } from './zoneDefinition';
import type { ZoneVolumeConfig } from '@/config/types';

/**
 * -----------------------------------------------------------------------------
 * ZoneEntry
 * -----------------------------------------------------------------------------
 * In-memory runtime object for each active zone.
 * Extends the static ZoneDefinition with dynamic runtime state and mappers.
 * -----------------------------------------------------------------------------
 */
export interface ZoneEntry {
  /** Numeric ID (same as ZoneDefinition.id). */
  id: number;

  /** Display name. */
  name: string;

  /** Original adapter definition (type + parameters). */
  adapter: ZoneDefinition['adapter'];

  /** Instance of the active StateMapper for this zone. */
  stateMapper: any;

  /** Instance of the active CommandMapper for this zone. */
  commandMapper: any;

  /** Instance of the active contentAdapter for this zone. */
  contentMapper?: any;

  /** Zone-specific volume presets. */
  volumes?: ZoneVolumeConfig;

  /** Source label (AudioServer / Extension) associated with the zone. */
  source?: string;

  /** Source serial identifier. */
  sourceSerial?: string;
}
