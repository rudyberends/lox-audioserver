import type { AudioOutputSettings } from '@/ports/types/audioFormat';

export interface SnapcastCorePort {
  listClients: () => Array<{
    clientId: string;
    streamId: string;
    connected: boolean;
    connectedAt: number;
    lastHelloId: number | null;
    latency: number;
  }>;
  setClientLatency: (
    clientId: string,
    latency: number,
  ) => { updated: boolean; connected: boolean; latency: number };
  setStream: (
    streamId: string,
    zoneId: number,
    output: AudioOutputSettings,
    stream: NodeJS.ReadableStream,
    clientIds: string[],
  ) => void;
  clearStream: (zoneId: number) => void;
  setClientStream: (clientId: string, streamId: string) => void;
  setClientVolumes: (clientIds: string[], volume: number) => void;
}
