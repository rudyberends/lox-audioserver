import type { HttpPreferences, PreferredOutput, ZoneOutput } from '@/ports/OutputsTypes';

export type OutputCapabilities = {
  preferredOutput?: PreferredOutput | null;
  httpPreferences?: HttpPreferences | null;
  latencyMs?: number | null;
};

export interface OutputsPort {
  listZoneOutputs(zoneId: number): ZoneOutput[];
  getCapabilities(output: ZoneOutput): OutputCapabilities;
}
