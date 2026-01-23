import { buildZoneOutputs } from '@/adapters/outputs/factory';
import type { OutputsPort, OutputCapabilities } from '@/ports/OutputsPort';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';

export class OutputsAdapter implements OutputsPort {
  constructor(private readonly ports: OutputPorts) {}

  public listZoneOutputs(zoneId: number): ZoneOutput[] {
    const cfg = this.ports.config.getConfig();
    const zone = cfg?.zones?.find((entry) => entry.id === zoneId) ?? null;
    if (!zone) {
      return [];
    }
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
