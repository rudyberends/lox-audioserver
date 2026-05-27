import { buildZoneOutputs } from '@/adapters/outputs/factory';
import type { OutputsPort, OutputCapabilities } from '@/ports/OutputsPort';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';
import type { ZoneConfig } from '@/domain/config/types';

export class OutputsAdapter implements OutputsPort {
  constructor(private readonly ports: OutputPorts) {}

  public buildOutputs(zone: ZoneConfig): ZoneOutput[] {
    return buildZoneOutputs(zone, this.ports);
  }

  public getCapabilities(output: ZoneOutput): OutputCapabilities {
    return {
      preferredOutput: output.getPreferredOutput?.() ?? null,
      httpPreferences: output.getHttpPreferences?.() ?? null,
      latencyMs: output.getLatencyMs?.() ?? null,
    };
  }
}

export function createOutputsAdapter(ports: OutputPorts): OutputsAdapter {
  return new OutputsAdapter(ports);
}
