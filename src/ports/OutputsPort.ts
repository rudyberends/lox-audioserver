import type { HttpPreferences, PreferredOutput, ZoneOutput } from '@/ports/OutputsTypes';
import type { ZoneConfig } from '@/domain/config/types';

export type OutputCapabilities = {
  preferredOutput?: PreferredOutput | null;
  httpPreferences?: HttpPreferences | null;
  latencyMs?: number | null;
};

export interface OutputsPort {
  /**
   * Build outputs for the given zone config. Accepts the config object directly
   * so callers can resolve outputs for ephemeral zones that aren't persisted
   * to the saved configuration (e.g. browser-registered zones).
   */
  buildOutputs(zone: ZoneConfig): ZoneOutput[];
  getCapabilities(output: ZoneOutput): OutputCapabilities;
}
