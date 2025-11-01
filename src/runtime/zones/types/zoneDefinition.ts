import type { ZoneVolumeConfig } from '@/config/types';

/**
 * -----------------------------------------------------------------------------
 * ZoneDefinition
 * -----------------------------------------------------------------------------
 * Static configuration object that defines how a zone is initialized.
 * Loaded from and persisted to the config store.
 * -----------------------------------------------------------------------------
 */
export interface ZoneDefinition {
  /** Numeric ID assigned by the AudioServer / Loxone. */
  id: number;

  /** Human-readable name of the zone (e.g., "Woonkamer"). */
  name: string;

  /** Adapter configuration — determines which protocol is used. */
  adapter: {
    /** Type identifier of the adapter (e.g., "beolink", "null"). */
    type: string;

    /** Adapter-specific configuration parameters. */
    parameters: Record<string, any>;
  };

  /** Event volume presets (tts, alarm, etc.). */
  volumes?: ZoneVolumeConfig;

  /** Identifier for the device providing the zone (AudioServer or extension). */
  source?: string;

  /** Serial number of the source device (AudioServer MAC or extension serial). */
  sourceSerial?: string;
}
